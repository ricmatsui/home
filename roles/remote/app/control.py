import asyncio
import base64
import json
import logging
import queue
import ssl
import threading

import janus
import websockets
from wakeonlan import send_magic_packet

from app.network import local_addresses, select_lan_interface

logger = logging.getLogger(__name__)

CLIENT_NAME = 'Home Remote'


class TvControl:
    def __init__(self, ip, mac, token, lan_cidr):
        self.ip = ip
        self.mac = mac
        self.token = token
        self.lan = select_lan_interface(local_addresses(), lan_cidr)
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
        name = base64.b64encode(CLIENT_NAME.encode('utf-8')).decode('utf-8')
        return (
            f'wss://{self.ip}:8002/api/v2/channels/samsung.remote.control'
            f'?name={name}&token={self.token}'
        )

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

            try:
                async with websockets.connect(
                    self._url(),
                    ssl=ssl_context,
                    open_timeout=2,
                    ping_interval=5,
                    ping_timeout=2,
                    close_timeout=2,
                ) as websocket:
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
            except Exception as error:
                logger.debug('<- error %s', error)

                if len(pending) > 0:
                    last_attempt_failed = True
                    self._wake()
