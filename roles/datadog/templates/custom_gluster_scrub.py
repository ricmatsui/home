import re

from checks import AgentCheck
from utils.subprocess_output import get_subprocess_output


class GlusterScrubCheck(AgentCheck):
    def check(self, instance):
        volume = instance['volume']
        timeout = instance.get('timeout', 30)
        output, err, retcode = get_subprocess_output(
            ['timeout', str(timeout), 'sudo', '-n', '/usr/sbin/gluster',
             'volume', 'bitrot', volume, 'scrub', 'status'], self.log,
            raise_on_empty_output=False
        )
        if 'Another transaction is in progress' in output + err:
            self.log.warning('glusterd is locked, skipping scrub status for %s', volume)
            return
        if retcode != 0:
            raise Exception('scrub status for {} exited {}: {}'.format(
                volume, retcode, (err or output).strip()))

        for section in re.split(r'^=+$', output, flags=re.MULTILINE):
            node = re.search(r'^Node: (\S+)$', section, re.MULTILINE)
            if not node:
                continue
            count = re.search(r'^Error count: (\d+)$', section, re.MULTILINE)
            if not count:
                raise Exception('no error count for {} on {}'.format(volume, node.group(1)))
            name = self.init_config['nodes'].get(node.group(1), node.group(1))
            self.gauge('gluster.scrub.corrupted_objects', int(count.group(1)),
                tags=['volume:{}'.format(volume), 'node:{}'.format(name)])
