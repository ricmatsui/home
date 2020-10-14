const { sh, cli, rawArgs } = require('tasksfile')

const kubectl = (options, name = 'Mysterious') => {
    sh(`sops exec-file kubeconfig.yml 'KUBECONFIG={} kubectl ${rawArgs().join(' ').replace(/'/, '\\\'')}'`, { nopipe: true });
}

cli({ kubectl });
