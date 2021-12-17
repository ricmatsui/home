const { sh, cli, rawArgs } = require('tasksfile')

const deploy = () => {
    sh(`pipenv run ansible-playbook playbook.yml ${rawArgs().join(' ')}`, { nopipe: true });
}

cli({ deploy });
