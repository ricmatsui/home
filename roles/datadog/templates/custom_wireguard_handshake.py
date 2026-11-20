import os
import re
import time

from checks import AgentCheck
from utils.subprocess_output import get_subprocess_output


class WireguardHandshakeCheck(AgentCheck):
    def check(self, instance):
        interface = instance['interface']
        if not os.path.exists('/sys/class/net/{}'.format(interface)):
            return

        names = self.peer_names(instance['config_path'])
        output, err, retcode = get_subprocess_output(
            ['sudo', '-n', '/usr/bin/wg', 'show', interface, 'latest-handshakes'], self.log,
            raise_on_empty_output=False
        )
        if retcode != 0:
            raise Exception('wg show {} exited {}: {}'.format(
                interface, retcode, (err or output).strip()))

        now = time.time()
        for line in output.splitlines():
            public_key, handshake = line.split()
            name = names.get(public_key)
            if not name or handshake == '0':
                continue
            self.gauge('wireguard.peer.handshake_age', now - int(handshake),
                tags=['interface:{}'.format(interface), 'peer:{}'.format(name)])

    def peer_names(self, config_path):
        output, err, retcode = get_subprocess_output(
            ['sudo', '-n', '/usr/bin/cat', config_path], self.log,
            raise_on_empty_output=False
        )
        if retcode != 0:
            raise Exception('cat {} exited {}: {}'.format(
                config_path, retcode, (err or output).strip()))

        names = {}
        pending_name = None
        name = None
        for line in output.splitlines():
            line = line.strip()
            comment = re.match(r'^#\s*Name:\s*(.+)$', line)
            if comment:
                pending_name = comment.group(1).strip()
            elif line.startswith('['):
                name = pending_name if line == '[Peer]' else None
                pending_name = None
            elif name and line.startswith('PublicKey'):
                names[line.split('=', 1)[1].strip()] = name
        return names
