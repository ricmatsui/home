import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import fs from 'fs';
import readline from 'readline';
import { Section, Action } from './types.js';
import { unlockWikiIfPossible, formatDateStr, readTodoFile, findDayFilePath, createDayFile, parseDayFile, partitionSections, writeDayFile, markDayAsDone, commitWiki, pushWiki, extractActions, sortSectionItems, upsertSection, updateTodayLink, linkAdjacentDays } from './lib.js';
import { fetchDailyForecast, formatWeatherLine, formatWeatherUnavailable } from './weather.js';
import * as donetick from './donetick.js';
import { seedJournalSection } from './journal.js';
import * as googleTasks from './googleTasks.js';
import { STATUS_SECTION, findStatusLine, foldLegacySections, formatStatusSection, withStatusLine } from './status.js';

const { PLANNER_DEBUG, PLANNER_RUN_DATE } = process.env;

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
        return { sections: foldLegacySections(parseDayFile(content)) };
    });

    const { processedSections, actions } = await DBOS.runStep(async () => {
        if (!sections) {
            return { processedSections: null as Section[] | null, actions: [] as Action[] };
        }

        const result = extractActions(sections, date);
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

    await DBOS.runStep(async () => {
        if (!dayFilePath) return;

        await linkAdjacentDays({
            previousPath: dayFilePath,
            previousDateStr: formatDateStr(date),
            nextPath: nextDayFilePath,
            nextDateStr: formatDateStr(nextDate),
        });
    });

    const { existingNextData } = await DBOS.runStep(async () => {
        const content = await fs.promises.readFile(nextDayFilePath, 'utf-8');
        return { existingNextData: foldLegacySections(parseDayFile(content)) };
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

    const { weatherLine } = await DBOS.runStep(async () => {
        try {
            return { weatherLine: formatWeatherLine(await fetchDailyForecast(formatDateStr(nextDate))) };
        } catch (error) {
            // A missing forecast is not worth failing the day's planning over,
            // but the day is opened saying so rather than silently short a line
            console.warn('Recording weather as unavailable', error);
            return { weatherLine: formatWeatherUnavailable(error) };
        }
    });

    const { donetickLine } = await DBOS.runStep(async () => {
        try {
            const chores = await donetick.fetchChores();
            return { donetickLine: donetick.formatDonetickLine(donetick.countDueOn(chores, nextDate)) };
        } catch (error) {
            // Counts that cannot be fetched are not worth failing the day over
            console.warn('Recording Donetick due counts as unavailable', error);
            return { donetickLine: donetick.formatDonetickUnavailable(error) };
        }
    });

    const { googleTasksLine } = await DBOS.runStep(async () => {
        try {
            const tasks = await googleTasks.fetchOpenTasks();
            return { googleTasksLine: googleTasks.formatGoogleTasksLine(googleTasks.countDueOn(tasks, nextDate)) };
        } catch (error) {
            console.warn('Recording Google Tasks due counts as unavailable', error);
            return { googleTasksLine: googleTasks.formatGoogleTasksUnavailable(error) };
        }
    });

    const { nextDataWithStatus } = await DBOS.runStep(async () => {
        const status = formatStatusSection([weatherLine, donetickLine, googleTasksLine]);
        return {
            nextDataWithStatus: seedJournalSection(upsertSection(mergedNextData, status, { before: 'Dates' })),
        };
    });

    await DBOS.runStep(async () => {
        await writeDayFile(nextDayFilePath, sortSectionItems(nextDataWithStatus));
    });

    // Recorded onto the line the day was opened with, so its overdue and due
    // counts stay alongside what came of them
    const opened = lastData?.find(section => section.name === STATUS_SECTION);

    const { donetickClosed } = await DBOS.runStep(async () => {
        if (!lastData) return { donetickClosed: null };

        const line = findStatusLine(opened, donetick.DONETICK_LABEL);

        try {
            const history = await donetick.fetchChoreHistory();
            return { donetickClosed: donetick.withCompletedCount(line, donetick.countCompletedOn(history, date)) };
        } catch (error) {
            // A count that cannot be fetched is not worth failing the day over
            console.warn('Recording Donetick completions as unavailable', error);
            return { donetickClosed: donetick.withCompletedUnavailable(line, error) };
        }
    });

    const { googleTasksClosed } = await DBOS.runStep(async () => {
        if (!lastData) return { googleTasksClosed: null };

        const line = findStatusLine(opened, googleTasks.GOOGLE_TASKS_LABEL);

        try {
            const tasks = await googleTasks.fetchTasksCompletedOn(date);
            return { googleTasksClosed: googleTasks.withCompletedCount(line, googleTasks.countCompletedOn(tasks, date)) };
        } catch (error) {
            console.warn('Recording Google Tasks completions as unavailable', error);
            return { googleTasksClosed: googleTasks.withCompletedUnavailable(line, error) };
        }
    });

    const { lastDataWithStatus } = await DBOS.runStep(async () => {
        if (!lastData || !donetickClosed || !googleTasksClosed) {
            return { lastDataWithStatus: null as Section[] | null };
        }

        const status = withStatusLine(
            withStatusLine(opened, donetick.DONETICK_LABEL, donetickClosed),
            googleTasks.GOOGLE_TASKS_LABEL,
            googleTasksClosed,
        );

        return { lastDataWithStatus: upsertSection(lastData, status, { before: 'Dates' }) };
    });

    await DBOS.runStep(async () => {
        if (!lastDataWithStatus || !dayFilePath) return;
        await writeDayFile(dayFilePath, sortSectionItems(lastDataWithStatus));
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
                existingSection.items.unshift(action.item);
            } else {
                targetSections.push({ name: action.sectionName, items: [action.item] });
            }

            await writeDayFile(targetPath, sortSectionItems(targetSections));
        });
    }

    await DBOS.runStep(async () => {
        await updateTodayLink(formatDateStr(nextDate), nextDayFilePath);
    });

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

    if (PLANNER_RUN_DATE) {
        // Anything trailing the date is ignored here but still varies the
        // workflow ID below, which is what makes a deliberate rerun possible
        const [year, month, day] = PLANNER_RUN_DATE.slice(0, 10).split('-').map(Number);

        // Local midnight, so a manual run lands on the same instant the daily
        // schedule would have produced for that date, DST included
        await DBOS.startWorkflow(enqueueWikiWorkflowIfNeeded, {
            // Deterministic, so redeploys and restart backoff cannot re-run it.
            // To force a rerun, suffix the date: PLANNER_RUN_DATE=2026-09-18-retry
            workflowID: `manual-${PLANNER_RUN_DATE}`,
        })(new Date(year, month - 1, day));
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
