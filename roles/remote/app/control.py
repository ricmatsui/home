import asyncio
import base64
import json
import logging
import queue
import ssl
import threading
from urllib.parse import urlencode

import janus
import websockets
from wakeonlan import send_magic_packet

logger = logging.getLogger(__name__)

CONNECT_EVENT = 'ms.channel.connect'
UNAUTHORIZED_EVENT = 'ms.channel.unauthorized'
TIMED_OUT_EVENT = 'ms.channel.timeOut'

# A human has to walk to the TV and accept the prompt, so an unpaired
# connection has to stay open far longer than a paired one, which we want to
# fail fast enough that the wake-on-lan fallback still feels immediate.
PAIRING_TIMEOUT = 60
PAIRED_TIMEOUT = 5
PAIRED_OPEN_TIMEOUT = 2


class Unauthorized(Exception):
    """The TV refused us: a token it no longer knows, or a declined prompt."""


class ChannelTimeout(Exception):
    """The socket opened but the channel never became ready: TV asleep."""


class TvControl:
    def __init__(self, ip, mac, client_name, token_store, lan):
        self.ip = ip
        self.mac = mac
        self.client_name = client_name
        self.token_store = token_store
        self.lan = lan
        self.message_queue = None

        logger.debug(
            'wol will use source %s broadcast %s',
            self.lan.source_ip,
            self.lan.broadcast_ip,
        )

    def start(self):
        handoff = queue.Queue()

        thread = threading.Thread(
            target=lambda: asyncio.run(self._process_messages(handoff)),
            daemon=True,
        )
        thread.start()

        self.message_queue = handoff.get()

    def send(self, message):
        self.message_queue.sync_q.put(message)

    def _wake(self):
        send_magic_packet(
            self.mac,
            ip_address=self.lan.broadcast_ip,
            interface=self.lan.source_ip,
        )
        logger.debug('-> wol')

    def _url(self):
        # Read per connect: the TV can rotate the token underneath us, and
        # pairing itself happens long after startup.
        query = {
            'name': base64.b64encode(self.client_name.encode('utf-8')).decode('utf-8')
        }

        token = self.token_store.read()

        if token is not None:
            query['token'] = token

        return (
            f'wss://{self.ip}:8002/api/v2/channels/samsung.remote.control'
            f'?{urlencode(query)}'
        )

    async def _open_channel(self, websocket, timeout):
        """Wait for the TV to admit us, and bank any token it hands over.

        Nothing may be sent before this returns: the websocket handshake only
        gets us a socket, and the TV drops remote keys aimed at a channel it
        has not opened yet.

        Returns whether this connection completed a first pairing, which
        leaves the caller holding a socket built without keepalive.
        """
        while True:
            response = json.loads(await asyncio.wait_for(websocket.recv(), timeout))
            event = response.get('event')

            if event == UNAUTHORIZED_EVENT:
                raise Unauthorized(response)

            if event == TIMED_OUT_EVENT:
                raise ChannelTimeout(response)

            if event != CONNECT_EVENT:
                logger.debug('<- before connect: %s', event)
                continue

            logger.debug('<- channel open')

            token = response.get('data', {}).get('token')
            previous = self.token_store.read()

            if not token or token == previous:
                return False

            logger.info('<- storing new token')
            self.token_store.write(token)

            return previous is None

    async def _process_messages(self, handoff):
        message_queue = janus.Queue()
        handoff.put(message_queue)

        pending = []
        last_attempt_failed = False

        while True:
            if len(pending) == 0:
                pending.append(await message_queue.async_q.get())

            ssl_context = ssl.SSLContext()
            ssl_context.verify_mode = ssl.CERT_NONE

            paired = self.token_store.read() is not None

            try:
                async with websockets.connect(
                    self._url(),
                    ssl=ssl_context,
                    open_timeout=PAIRED_OPEN_TIMEOUT if paired else PAIRING_TIMEOUT,
                    # Keepalives would close the socket mid-prompt, long
                    # before anyone reaches the TV to accept it.
                    ping_interval=5 if paired else None,
                    ping_timeout=2,
                    close_timeout=2,
                ) as websocket:
                    just_paired = await self._open_channel(
                        websocket, PAIRED_TIMEOUT if paired else PAIRING_TIMEOUT
                    )

                    if just_paired:
                        # This socket was opened without keepalive so the
                        # prompt could stay up. The library starts that task
                        # once, at open, so the only way to get it is a new
                        # connection. Pending survives, so the gesture that
                        # triggered pairing still lands.
                        logger.debug('paired, reconnecting with keepalive')
                        continue

                    while len(pending) > 0:
                        if last_attempt_failed and pending[0]['kind'] == 'powerOn':
                            pending.pop(0)
                            logger.debug('! skipping powerOn')
                        else:
                            await websocket.send(json.dumps(pending[0]['data']))
                            pending.pop(0)
                            logger.debug('-> sent')

                        last_attempt_failed = False

                        while True:
                            next_message_task = asyncio.create_task(
                                message_queue.async_q.get()
                            )
                            recv_task = asyncio.create_task(websocket.recv())

                            done, incomplete = await asyncio.wait(
                                [next_message_task, recv_task],
                                timeout=3600,
                                return_when=asyncio.FIRST_COMPLETED,
                            )

                            if next_message_task in done:
                                logger.debug('next message done')
                                pending.append(next_message_task.result())
                            else:
                                logger.debug('next message cancel')
                                next_message_task.cancel()

                            if recv_task in done:
                                logger.debug('<- recv: %s', recv_task.result())
                            else:
                                recv_task.cancel()

                            if len(done) == 0 or next_message_task in done:
                                logger.debug('exiting')
                                break
            except Unauthorized as error:
                # The TV is plainly awake, so waking it is pointless, and the
                # token it just refused will be refused again. Dropping it
                # sends the next gesture through the pairing path instead.
                logger.warning('<- unauthorized, clearing token: %s', error)
                self.token_store.clear()
                pending.clear()
                last_attempt_failed = False
            except Exception as error:
                if isinstance(error, ChannelTimeout):
                    logger.debug('<- tv asleep: %s', error)
                else:
                    logger.debug('<- error %s', error)

                if len(pending) > 0:
                    last_attempt_failed = True
                    self._wake()
