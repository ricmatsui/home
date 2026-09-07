const path = require('path')
const { sh, cli, rawArgs } = require('tasksfile')

const projectPath = (...paths) => {
    return path.join(__dirname, ...paths)
}

const sshEnv = { ...process.env, TERM: 'xterm' }

const publishDataset = () => {
    sh('scp -S /usr/bin/ssh pi:/mnt/gluster/remote/data/recordings.jsonl recordings.jsonl', {
        cwd: projectPath('model'),
        nopipe: true,
        env: sshEnv,
    });

    sh(`poetry run python publish_dataset.py ${rawArgs().join(' ')}`, {
        cwd: projectPath('model'),
        nopipe: true,
    });
}

const train = () => {
    sh('poetry run python train.py', {
        cwd: projectPath('model'),
        nopipe: true,
        env: { ...process.env, TF_USE_LEGACY_KERAS: '1' },
    });
}

const publishModel = () => {
    sh(`poetry run python publish_model.py ${rawArgs().join(' ')}`, {
        cwd: projectPath('model'),
        nopipe: true,
    });
}

const monitorTraining = () => {
    sh('poetry run tensorboard --logdir logs', {
        cwd: projectPath('model'),
        nopipe: true,
    });
}

cli({ publishDataset, train, publishModel, monitorTraining });
