import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { simpleGit } from 'simple-git';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const { WIKI_PATH, WIKI_REMOTE, DOMAIN, PLANNER_DEBUG } = process.env;

if (!WIKI_PATH) {
    throw new Error('WIKI_PATH is not set');
}

const wikiQueue = new WorkflowQueue('wiki', { concurrency: 1 });

const wikiFunction = async (date: Date) => {
    await DBOS.runStep(async () => {
        try {
            const lockFile = path.resolve(WIKI_PATH, '.git', 'index.lock');
            const stat = await fs.promises.stat(lockFile);
            const ageMs = Date.now() - stat.mtimeMs;

            console.warn(`Existing index.lock (age: ${Math.round(ageMs / 1000 / 60)}m)`);

            if (ageMs < 60 * 60 * 1000) {
                throw new Error('Wiki repo is locked');
            }

            console.log('Removing index.lock');
            await fs.promises.unlink(lockFile);
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                return;
            }

            throw error;
        }
    });

    await DBOS.runStep(async () => {
        console.log('Committing wiki');
        const git = simpleGit({ baseDir: path.resolve(WIKI_PATH) });

        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const localDate = `${year}-${month}-${day}`;

        await git.addConfig('user.name', 'Planner');
        await git.addConfig('user.email', `planner@${DOMAIN}`);
        await git.add(['.']);
        await git.commit(localDate);
        console.log('Committed wiki');
    });
    
    await DBOS.runStep(async () => {
        console.log('Pushing wiki');
        const git = simpleGit({ baseDir: path.resolve(WIKI_PATH) });
        await git.push(WIKI_REMOTE, 'main');
        console.log('Pushed wiki');
    });
};

const wikiWorkflow = DBOS.registerWorkflow(wikiFunction);

const enqueueFunction = async (date: Date) => {
    const pending = await DBOS.runStep(async () => {
        return await DBOS.listWorkflows({
            queueName: wikiQueue.name,
            queuesOnly: true,
        });
    });

    if (pending.length) {
        console.log('Skipping enqueueing wiki workflow');
        return;
    }

    await DBOS.runStep(async () => {
        console.log('Enqueuing wiki workflow');
    });

    await DBOS.startWorkflow(wikiWorkflow, {
        queueName: wikiQueue.name,
    })(date);
};

const enqueueWikiWorkflowIfNeeded = DBOS.registerWorkflow(enqueueFunction);

async function main() {
    DBOS.setConfig({
        name: 'planner',
        systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL,
        applicationVersion: '0.1.0',
    });

    await DBOS.launch();

    if (PLANNER_DEBUG) {
        await DBOS.deleteSchedule('daily');
    } else {
        await DBOS.applySchedules([
            {
                scheduleName: 'daily',
                workflowFn: enqueueWikiWorkflowIfNeeded,
                schedule: '0 0 * * *',
            }
        ]);
    }

    const input = readline.createInterface({ input: process.stdin });

    input.on('line', async () => {
        await DBOS.startWorkflow(enqueueWikiWorkflowIfNeeded)(new Date());
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
