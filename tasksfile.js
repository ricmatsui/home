const { sh, cli } = require('tasksfile')

const deploy = () => {
    sh('pipenv run ansible-playbook playbook.yml', { nopipe: true });
}

cli({ deploy });
