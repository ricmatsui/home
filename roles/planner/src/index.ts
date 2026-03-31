import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import fs from 'fs';
import readline from 'readline';
import { Section, Action } from './types.js';
import { unlockWikiIfPossible, formatDateStr, readTodoFile, findDayFilePath, createDayFile, parseDayFile, partitionSections, writeDayFile, markDayAsDone, commitWiki, pushWiki, extractActions } from './lib.js';

const { PLANNER_DEBUG } = process.env;

const wikiQueue = new WorkflowQueue('wiki', { concurrency: 1 });

const wikiFunction = async (nextDate: Date) => {
    const date = new Date(nextDate);
    date.setDate(date.getDate() - 1);

    await DBOS.runStep(async () => {
        await unlockWikiIfPossible();
    });

    await DBOS.runStep(async () => {
        await commitWiki(`${formatDateStr(new Date())} Start`);
    });

    const { dayFilePath } = await DBOS.runStep(async () => {
        const todoFile = await readTodoFile();
        return { dayFilePath: findDayFilePath(todoFile, formatDateStr(date)) };
    });

    const { sections } = await DBOS.runStep(async () => {
        if (!dayFilePath) {
            return { sections: null };
        }

        const content = await fs.promises.readFile(dayFilePath, 'utf-8');
        return { sections: parseDayFile(content) };
    });

    const { processedSections, actions } = await DBOS.runStep(async () => {
        if (!sections) {
            return { processedSections: null as Section[] | null, actions: [] as Action[] };
        }

        const result = extractActions(sections, nextDate);
        return { processedSections: result.sections, actions: result.actions };
    });

    const { lastData, nextData } = await DBOS.runStep(async () => {
        if (!processedSections) {
            return { lastData: null, nextData: null };
        }

        return partitionSections(processedSections);
    });

    const { nextDayFilePath } = await DBOS.runStep(async () => {
        const nextDateStr = formatDateStr(nextDate);

        const todoFile = await readTodoFile();

        const existing = findDayFilePath(todoFile, nextDateStr);
        if (existing) {
            return { nextDayFilePath: existing };
        }

        return { nextDayFilePath: await createDayFile(todoFile, nextDateStr) };
    });

    const { existingNextData } = await DBOS.runStep(async () => {
        const content = await fs.promises.readFile(nextDayFilePath, 'utf-8');
        return { existingNextData: parseDayFile(content) };
    });

    const { mergedNextData } = await DBOS.runStep(async () => {
        if (!nextData) {
            return { mergedNextData: existingNextData };
        }
        if (!existingNextData || existingNextData.length === 0) {
            return { mergedNextData: nextData };
        }

        const merged: Section[] = [];
        const existingByName = new Map(existingNextData.map(s => [s.name, s]));

        for (const section of nextData) {
            const existing = existingByName.get(section.name);
            if (!existing) {
                merged.push(section);
            } else {
                merged.push({
                    name: section.name,
                    items: [...existing.items, ...section.items],
                });
                existingByName.delete(section.name);
            }
        }

        for (const section of existingByName.values()) {
            merged.push(section);
        }

        return { mergedNextData: merged };
    });

    await DBOS.runStep(async () => {
        if (!mergedNextData) return;
        await writeDayFile(nextDayFilePath, mergedNextData);
    });

    await DBOS.runStep(async () => {
        if (!lastData || !dayFilePath) return;
        await writeDayFile(dayFilePath, lastData);
    });

    await DBOS.runStep(async () => {
        if (!dayFilePath) return;
        const todoFile = await readTodoFile();
        const dateStr = formatDateStr(date);
        await markDayAsDone(todoFile, dateStr);
    });

    for (const action of actions) {
        if (action.kind !== 'addItem') continue;

        await DBOS.runStep(async () => {
            const todoFile = await readTodoFile();

            let targetPath = findDayFilePath(todoFile, action.targetDate);
            if (!targetPath) {
                targetPath = await createDayFile(todoFile, action.targetDate);
            }

            const content = await fs.promises.readFile(targetPath, 'utf-8');
            const targetSections = parseDayFile(content);

            const existingSection = targetSections.find(s => s.name === action.sectionName);
            if (existingSection) {
                existingSection.items.push(action.item);
            } else {
                targetSections.push({ name: action.sectionName, items: [action.item] });
            }

            await writeDayFile(targetPath, targetSections);
        });
    }

    await DBOS.runStep(async () => {
        await commitWiki(`${formatDateStr(new Date())} Planning`);
    });
    
    await DBOS.runStep(async () => {
        await pushWiki();
    });
};

const wikiWorkflow = DBOS.registerWorkflow(wikiFunction);

const enqueueFunction = async (date: Date) => {
    const { pending } = await DBOS.runStep(async () => {
        return {
            pending: await DBOS.listWorkflows({
                queueName: wikiQueue.name,
                queuesOnly: true,
            }),
        };
    });

    if (pending.length) {
        console.log('Skipping enqueueing wiki workflow');
        return;
    }

    await DBOS.runStep(async () => {
        console.log('Enqueuing wiki workflow', { date });
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
        await DBOS.startWorkflow(enqueueWikiWorkflowIfNeeded)(
            new Date('2026-03-07T08:00:00.000Z')
        );
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
