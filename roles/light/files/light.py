from bluepy.btle import Scanner, DefaultDelegate
from datadog import initialize, statsd

import socket
import json
import asyncio
import os
from threading import Thread
import logging

initialize()

logging.basicConfig()

logger = logging.getLogger('light')
logger.setLevel(logging.DEBUG)

def _encrypt_command(string):
    key = 171
    result = b''

    for i in bytes(string.encode('latin-1')):
        a = key ^ i
        key = a
        result += bytes([a])
    return result

def _decrypt_command(string):

    key = 171
    result = b''
    for i in bytes(string):
        a = key ^ i
        key = i
        result += bytes([a])
    return result.decode('latin-1')

class CommandProtocol:
    def __init__(self, command, on_complete):
        self.command = command
        self.on_complete = on_complete
        self.transport = None
        self.result = None

    def connection_made(self, transport):
        self.transport = transport
        self.transport.sendto(_encrypt_command(json.dumps(self.command)))
        logger.debug('Sent command')

    def datagram_received(self, data, addr):
        logger.debug('Received response')
        self.result = json.loads(_decrypt_command(data))
        self.transport.close()

    def error_received(self, exception):
        self.on_complete.set_exception(exception)

    def connection_lost(self, exc):
        if self.on_complete.cancelled():
            logger.debug('Command cancelled')
            return

        if self.result:
            logger.debug('Command completed')
            self.on_complete.set_result(self.result)
            return

        logger.debug('Command exception')
        self.on_complete.set_exception(RuntimeError('Connection lost without a result'))

async def send_command(command):
    loop = asyncio.get_running_loop()
    on_complete = loop.create_future()
    transport, protocol = await loop.create_datagram_endpoint(
            lambda: CommandProtocol(command, on_complete),
            remote_addr=(os.environ['LIGHT_IP_ADDRESS'], 9999)
        )

    return transport, on_complete

async def blast_command(command, count):
    logger.info('Blast command: %s', json.dumps(command))
    commands = [await send_command(command) for _ in range(count)]

    try:
        done, pending = await asyncio.wait(
                [on_complete for _, on_complete in commands],
                timeout=5,
                return_when=asyncio.FIRST_COMPLETED
                )

        for pending_complete in pending:
            pending_complete.cancel()

        logger.debug('Blast result: %s', json.dumps(dict(
            done=len(done),
            pending=len(pending))))
        return done.pop().result()
    finally:
        for transport, _ in commands:
            transport.close()
        logger.debug('Blast transports closed')


async def toggle_light_with_retry():
    try:
        await toggle_light()
    except:
        try:
            await toggle_light()
        except:
            statsd.increment('lightpuck.toggle_retry_error')
            logger.error('Toggle retry error')

async def toggle_light():
    info_command = {
        'system': { 'get_sysinfo': {} }
    }

    context = {
        'child_ids': [
            os.environ['LIGHT_CHILD_ID'] + '00',
        ]
    }

    on_command = {
        'context': context,
        'system': {
            'set_relay_state': {
                'state': 1,
            },
        },
    }

    off_command = {
        'context': context,
        'system': {
            'set_relay_state': {
                'state': 0,
            },
        },
    }

    try:
        logger.info('Toggle start')
        info = await blast_command(info_command, 30)
        statsd.increment('lightpuck.toggle_info')
        light = next(light for light in info['system']['get_sysinfo']['children'] if light['id'] == '00')
        logger.debug('Light status: %s', json.dumps(light))

        light_on = light['state'] == 1
        logger.debug('Light on: %s', light_on)

        if light_on:
            logger.info('Toggle off')
            await blast_command(off_command, 30)
            statsd.increment('lightpuck.toggle_off')
        else:
            logger.info('Toggle on')
            await blast_command(on_command, 30)
            statsd.increment('lightpuck.toggle_on')
    except:
        statsd.increment('lightpuck.toggle_error')
        logger.error('Toggle error')
        raise



def get_service_value(raw_data, uuid, length):
    index = raw_data.index(bytes(reversed(uuid))) + len(uuid)
    return bytes(raw_data[index:index+length])


class ScanDelegate(DefaultDelegate):
    def __init__(self):
        DefaultDelegate.__init__(self)
        self.last_button_press_by_addr = {}

    def handleDiscovery(self, dev, isNewDev, isNewData):
        if dev.addr not in os.environ['LIGHT_PUCK_MAC_ADDRESSES'].split(','):
            return

        tags = ['puck:' + dev.addr[-5:].replace(':', '')];
        statsd.increment('lightpuck.discovery', tags=tags)
        logger.debug('Light puck discovery')

        try:
            battery = get_service_value(dev.rawData, bytes.fromhex('180f'), 1)[0]
            temperature_whole, temperature_decimal = get_service_value(dev.rawData, bytes.fromhex('1809'), 2)
            button_pressed, button_press_count = get_service_value(dev.rawData, bytes.fromhex('1815'), 2)

            temperature = (temperature_whole + temperature_decimal/10.0)*1.8+32

            logger.info('Light puck data: %s', json.dumps(dict(
                address=dev.addr,
                battery=battery,
                temperature=temperature,
                button_pressed=button_pressed,
                button_press_count=button_press_count
                )))
            statsd.gauge('lightpuck.battery', battery, tags=tags)
            statsd.gauge('lightpuck.temperature', temperature, tags=tags)

            if dev.addr in self.last_button_press_by_addr:
                last_button_press = self.last_button_press_by_addr[dev.addr]

                if last_button_press != button_press_count and button_pressed:
                    diff_press_count = button_press_count
                    if diff_press_count < last_button_press:
                        diff_press_count += 256

                    statsd.increment('lightpuck.button_pressed', value=diff_press_count-last_button_press, tags=tags)
                    asyncio.run(toggle_light_with_retry())

            self.last_button_press_by_addr[dev.addr] = button_press_count


        except:
            logger.warning('Light puck failed to parse data: %s', json.dumps(dict(address=dev.addr)))


async def monitor():
    logger.info('Monitor started')

    while True:
        try:
            transport, on_complete = await send_command({
                'system': { 'get_sysinfo': {} }
                })

            try:
                await asyncio.wait_for(on_complete, timeout=5)

                if on_complete.result()['system']['get_sysinfo']['sw_ver']:
                    logger.info('Monitor passed')
                    statsd.increment('lightpuck.monitor.passed')
                else:
                    logger.warning('Monitor failed')
                    statsd.increment('lightpuck.monitor.failed')
            finally:
                transport.close()
        except:
            logger.error('Monitor error')
            statsd.increment('lightpuck.monitor.error')

        await asyncio.sleep(300)

    logger.error('Monitor ended')

monitor_thread = Thread(target=lambda: asyncio.run(monitor()))
monitor_thread.daemon = True
monitor_thread.start()


try:
    scanner = Scanner().withDelegate(ScanDelegate())
    scanner.start(passive=True)
    while True:
        statsd.increment('lightpuck.scan')
        scanner.process(10)
finally:
    scanner.stop()
