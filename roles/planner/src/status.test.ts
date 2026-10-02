import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findStatusLine, foldLegacySections, formatStatusSection, withStatusLine } from './status.js';
import { parseDayFile, serializeSections } from './lib.js';
import { Section } from './types.js';

function note(text: string) {
    return { status: 'note' as const, text, children: [] };
}

const opened = formatStatusSection([
    'Overcast 74°/58°F, N 14/21 mph, 6:46am - 7:38pm UV 7',
    'Donetick: 3 overdue, 5 due',
    'Google Tasks: 1 overdue, 3 due',
]);

describe('formatStatusSection', () => {
    it('writes each line as a note in the order given', () => {
        assert.deepEqual(formatStatusSection(['Overcast', 'Donetick: 3 overdue, 5 due']), {
            name: 'Status',
            items: [note('Overcast'), note('Donetick: 3 overdue, 5 due')],
        });
    });

    it('survives a round trip through the day file format', () => {
        assert.deepEqual(parseDayFile(serializeSections([opened])), [opened]);
    });
});

describe('findStatusLine', () => {
    it('finds a source\'s line by its label', () => {
        assert.equal(findStatusLine(opened, 'Google Tasks'), 'Google Tasks: 1 overdue, 3 due');
    });

    it('finds nothing for a source the day never got a line for', () => {
        assert.equal(findStatusLine(formatStatusSection(['Overcast']), 'Donetick'), undefined);
        assert.equal(findStatusLine(undefined, 'Donetick'), undefined);
    });
});

describe('withStatusLine', () => {
    it('replaces a source\'s line where it sits', () => {
        assert.deepEqual(
            withStatusLine(opened, 'Donetick', 'Donetick: 3 overdue, 5 due, 7 completed').items.map(i => i.text),
            [
                'Overcast 74°/58°F, N 14/21 mph, 6:46am - 7:38pm UV 7',
                'Donetick: 3 overdue, 5 due, 7 completed',
                'Google Tasks: 1 overdue, 3 due',
            ],
        );
    });

    it('adds a line the day never got at the end', () => {
        assert.deepEqual(
            withStatusLine(formatStatusSection(['Overcast']), 'Donetick', 'Donetick: 7 completed').items.map(i => i.text),
            ['Overcast', 'Donetick: 7 completed'],
        );
    });

    it('starts a section on a day that was never opened with one', () => {
        assert.deepEqual(withStatusLine(undefined, 'Donetick', 'Donetick: 7 completed'), {
            name: 'Status',
            items: [note('Donetick: 7 completed')],
        });
    });

    it('leaves the section it was given untouched', () => {
        withStatusLine(opened, 'Donetick', 'Donetick: 7 completed');

        assert.equal(opened.items[1].text, 'Donetick: 3 overdue, 5 due');
    });
});

describe('foldLegacySections', () => {
    const legacy: Section[] = [
        { name: 'Weather', items: [note('Overcast 74°/58°F')] },
        { name: 'Donetick', items: [note('3 overdue'), note('5 due today')] },
        { name: 'Google Tasks', items: [note('Due counts unavailable: fetch failed')] },
        { name: 'Dates', items: [] },
        { name: 'Work', items: [] },
    ];

    it('folds the old sections into one Status section where they stood', () => {
        assert.deepEqual(foldLegacySections([{ name: 'Other', items: [] }, ...legacy]), [
            { name: 'Other', items: [] },
            formatStatusSection([
                'Overcast 74°/58°F',
                'Donetick: 3 overdue, 5 due today',
                'Google Tasks: Due counts unavailable: fetch failed',
            ]),
            { name: 'Dates', items: [] },
            { name: 'Work', items: [] },
        ]);
    });

    it('lets the folded counts be closed like any opened today', () => {
        const status = foldLegacySections(legacy)[0];

        assert.equal(findStatusLine(status, 'Donetick'), 'Donetick: 3 overdue, 5 due today');
    });

    it('leaves a day without the old sections as it is', () => {
        const sections = [opened, { name: 'Work', items: [] }];

        assert.equal(foldLegacySections(sections), sections);
    });

    it('keeps a Status section already there over the old sections', () => {
        assert.deepEqual(foldLegacySections([...legacy, opened]).map(s => s.name), ['Dates', 'Work', 'Status']);
    });
});
