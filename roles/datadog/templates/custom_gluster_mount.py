from checks import AgentCheck
from utils.subprocess_output import get_subprocess_output


class GlusterMountCheck(AgentCheck):
    def check(self, instance):
        mount_point = instance.get('mount_point', '/mnt/gluster')
        timeout = instance.get('timeout', 10)
        try:
            output, err, retcode = get_subprocess_output(
                ['timeout', str(timeout), 'ls', mount_point], self.log,
                raise_on_empty_output=False
            )
            if retcode == 0 and output.strip():
                self.service_check('gluster.mount.healthy', AgentCheck.OK)
            else:
                self.service_check('gluster.mount.healthy', AgentCheck.CRITICAL,
                    message='{} is empty or ls failed'.format(mount_point))
        except Exception as e:
            self.service_check('gluster.mount.healthy', AgentCheck.CRITICAL,
                message='Error checking {}: {}'.format(mount_point, e))
