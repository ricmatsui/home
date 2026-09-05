import { Section } from './types.js';

export const JOURNAL_SECTION = 'Journal';

// Details first, so the summary is written with them already in view
const PROMPTS = ['Highlight', 'Friction', 'Learned', 'Summary'];

export function formatJournalSection(): Section {
    return {
        name: JOURNAL_SECTION,
        items: PROMPTS.map(prompt => ({
            status: 'note' as const,
            text: `${prompt}:`,
            children: [],
        })),
    };
}

// Seeded only when absent, so an entry written ahead of time is never overwritten
export function seedJournalSection(sections: Section[]): Section[] {
    if (sections.some(section => section.name === JOURNAL_SECTION)) {
        return sections;
    }

    return [...sections, formatJournalSection()];
}
