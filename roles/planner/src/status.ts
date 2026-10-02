import { Section } from './types.js';

export const STATUS_SECTION = 'Status';

// The forecast and each source's counts, one line apiece, in the order given
export function formatStatusSection(lines: string[]): Section {
    return {
        name: STATUS_SECTION,
        items: lines.map(text => ({ status: 'note' as const, text, children: [] })),
    };
}

// A source's line is the one led by its label; the forecast's line has none
export function findStatusLine(section: Section | undefined, label: string): string | undefined {
    return section?.items.find(item => item.text.startsWith(`${label}: `))?.text;
}

// Replaced where it sits, so closing the day leaves the lines in the order the
// day was opened with. A line the day never got is added at the end.
export function withStatusLine(section: Section | undefined, label: string, text: string): Section {
    const items = section?.items ?? [];
    const index = items.findIndex(item => item.text.startsWith(`${label}: `));
    const line = { status: 'note' as const, text, children: [] };

    return {
        name: STATUS_SECTION,
        items: index === -1
            ? [...items, line]
            : items.map((item, i) => i === index ? line : item),
    };
}

/*
 * Days opened before the forecast and the due counts shared a section carry
 * them as three sections of their own. Only the day open at the changeover has
 * them, and once it has been closed this can go.
 */
const LEGACY_WEATHER_SECTION = 'Weather';
const LEGACY_SECTIONS = [LEGACY_WEATHER_SECTION, 'Donetick', 'Google Tasks'];

export function foldLegacySections(sections: Section[]): Section[] {
    const first = sections.findIndex(section => LEGACY_SECTIONS.includes(section.name));
    if (first === -1) return sections;

    const others = sections.filter(section => !LEGACY_SECTIONS.includes(section.name));
    if (others.some(section => section.name === STATUS_SECTION)) return others;

    const lines = LEGACY_SECTIONS.flatMap(name => {
        const legacy = sections.find(section => section.name === name);
        if (!legacy || legacy.items.length === 0) return [];

        const text = legacy.items.map(item => item.text).join(', ');
        return [name === LEGACY_WEATHER_SECTION ? text : `${name}: ${text}`];
    });

    // Nothing ahead of the first legacy section was dropped, so it lands there
    return [...others.slice(0, first), formatStatusSection(lines), ...others.slice(first)];
}
