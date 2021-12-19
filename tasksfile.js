const { sh, cli, rawArgs } = require('tasksfile')
const path = require('path')

const setup = () => {
    sh('pipenv run ansible-galaxy collection install -r requirements.yml');
}

const deploy = () => {
    sh(`pipenv run ansible-playbook playbook.yml ${rawArgs().join(' ')}`, { nopipe: true });
}

const temporal = {
    web: () => {
        sh(`sops exec-env env.yml 'docker-compose up'`, {
            cwd: path.join(__dirname, 'temporalite'),
            nopipe: true,
        });
    },
}

cli({ setup, deploy, temporal });
