import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatJournalSection, seedJournalSection } from './journal.js';
import { parseDayFile, serializeSections } from './lib.js';
import { Section } from './types.js';

describe('formatJournalSection', () => {
    it('renders the prompts as notes, with the summary last', () => {
        assert.deepEqual(formatJournalSection(), {
            name: 'Journal',
            items: [
                { status: 'note', text: 'Highlight:', children: [] },
                { status: 'note', text: 'Friction:', children: [] },
                { status: 'note', text: 'Learned:', children: [] },
                { status: 'note', text: 'Summary:', children: [] },
            ],
        });
    });

    it('survives a round trip through the day file format', () => {
        const section = formatJournalSection();

        assert.deepEqual(parseDayFile(serializeSections([section])), [section]);
    });
});

describe('seedJournalSection', () => {
    const work: Section = {
        name: 'Work',
        items: [{ status: 'incomplete', text: 'Todo', children: [] }],
    };

    it('appends the prompts after every other section', () => {
        const result = seedJournalSection([work]);

        assert.deepEqual(result.map(s => s.name), ['Work', 'Journal']);
        assert.deepEqual(result[1], formatJournalSection());
    });

    it('leaves a journal that was already written alone', () => {
        const written: Section = {
            name: 'Journal',
            items: [{ status: 'note', text: 'Highlight: shipped it', children: [] }],
        };

        assert.deepEqual(seedJournalSection([work, written]), [work, written]);
    });

    it('does not mutate the input sections', () => {
        const sections: Section[] = [work];

        seedJournalSection(sections);

        assert.deepEqual(sections.map(s => s.name), ['Work']);
    });
});
