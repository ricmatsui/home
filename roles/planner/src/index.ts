import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import fs from 'fs';
import readline from 'readline';
import { Section, Action } from './types.js';
import { unlockWikiIfPossible, formatDateStr, readTodoFile, findDayFilePath, createDayFile, parseDayFile, partitionSections, writeDayFile, markDayAsDone, commitWiki, pushWiki, extractActions, sortSectionItems, upsertSection, updateTodayLink } from './lib.js';
import { fetchDailyForecast, formatWeatherSection, formatWeatherUnavailable, WEATHER_SECTION } from './weather.js';
import { DONETICK_SECTION, fetchChoreHistory, fetchChores, countCompletedOn, countDueOn, formatDonetickSection, formatDonetickUnavailable, withCompletedCount, withCompletedUnavailable } from './donetick.js';
import { seedJournalSection } from './journal.js';

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
        return { sections: parseDayFile(content) };
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

    const { nextDataWithWeather } = await DBOS.runStep(async () => {
        try {
            const daily = await fetchDailyForecast(formatDateStr(nextDate));
            return {
                nextDataWithWeather: upsertSection(
                    mergedNextData,
                    formatWeatherSection(daily),
                    { before: 'Dates' },
                ),
            };
        } catch (error) {
            // A missing forecast is not worth failing the day's planning over,
            // but the day is opened saying so rather than silently short a section
            console.warn('Recording weather as unavailable', error);
            return {
                nextDataWithWeather: upsertSection(
                    mergedNextData,
                    formatWeatherUnavailable(error),
                    { before: 'Dates' },
                ),
            };
        }
    });

    const { nextDataWithJournal } = await DBOS.runStep(async () => {
        return { nextDataWithJournal: seedJournalSection(nextDataWithWeather) };
    });

    const { nextDataWithDonetick } = await DBOS.runStep(async () => {
        try {
            const chores = await fetchChores();
            return {
                nextDataWithDonetick: upsertSection(
                    nextDataWithJournal,
                    formatDonetickSection(countDueOn(chores, nextDate)),
                    { after: WEATHER_SECTION },
                ),
            };
        } catch (error) {
            // Counts that cannot be fetched are not worth failing the day over
            console.warn('Recording Donetick due counts as unavailable', error);
            return {
                nextDataWithDonetick: upsertSection(
                    nextDataWithJournal,
                    formatDonetickUnavailable(error),
                    { after: WEATHER_SECTION },
                ),
            };
        }
    });

    await DBOS.runStep(async () => {
        await writeDayFile(nextDayFilePath, sortSectionItems(nextDataWithDonetick));
    });

    const { lastDataWithDonetick } = await DBOS.runStep(async () => {
        if (!lastData) {
            return { lastDataWithDonetick: null as Section[] | null };
        }

        // Recorded onto the section the day was opened with, so its overdue and
        // due counts stay alongside what came of them
        const opened = lastData.find(section => section.name === DONETICK_SECTION);

        try {
            const history = await fetchChoreHistory();

            return {
                lastDataWithDonetick: upsertSection(
                    lastData,
                    withCompletedCount(opened, countCompletedOn(history, date)),
                    { after: WEATHER_SECTION },
                ),
            };
        } catch (error) {
            // A count that cannot be fetched is not worth failing the day over
            console.warn('Recording Donetick completions as unavailable', error);
            return {
                lastDataWithDonetick: upsertSection(
                    lastData,
                    withCompletedUnavailable(opened, error),
                    { after: WEATHER_SECTION },
                ),
            };
        }
    });

    await DBOS.runStep(async () => {
        if (!lastDataWithDonetick || !dayFilePath) return;
        await writeDayFile(dayFilePath, sortSectionItems(lastDataWithDonetick));
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
