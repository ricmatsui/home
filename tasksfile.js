const { sh, cli, rawArgs } = require('tasksfile')

const setup = () => {
    sh('yarn', { nopipe: true });
    sh('poetry install', { nopipe: true });
    sh('poetry run ansible-galaxy collection install -r requirements.yml', { nopipe: true });
}

const deploy = () => {
    sh(`poetry run ansible-playbook playbook.yml ${rawArgs().join(' ')}`, { nopipe: true });
}

cli({ setup, deploy });
