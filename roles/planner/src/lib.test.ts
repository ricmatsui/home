import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAction, extractActions } from './lib.js';
import { Section } from './types.js';

describe('parseAction', () => {
    const ref = new Date('2026-04-22');

    it('parses weekday name', () => {
        const result = parseAction('-> thursday', ref);
        assert.equal(result?.targetDate, '2026-04-23');
    });

    it('parses "next thursday"', () => {
        const result = parseAction('-> next thursday', ref);
        assert.ok(result);
        // chrono with forwardDate returns the next thursday
        const d = new Date(result.targetDate);
        assert.equal(d.getDay(), 4); // Thursday
        assert.ok(d >= ref);
    });

    it('parses "next week" as next sunday', () => {
        const result = parseAction('-> next week', ref);
        assert.ok(result);
        const d = new Date(result.targetDate);
        assert.equal(d.getDay(), 0); // Sunday
        assert.ok(d > ref);
    });

    it('parses bare month name to 1st of that month, forward-looking', () => {
        const result = parseAction('-> may', ref);
        assert.equal(result?.targetDate, '2026-05-01');
    });

    it('parses bare month name past current month to next year', () => {
        const result = parseAction('-> january', ref);
        assert.equal(result?.targetDate, '2027-01-01');
    });

    it('parses MM-DD format', () => {
        const result = parseAction('-> 05-01', ref);
        assert.equal(result?.targetDate, '2026-05-01');
    });

    it('parses full date', () => {
        const result = parseAction('-> 2026-12-25', ref);
        assert.equal(result?.targetDate, '2026-12-25');
    });

    it('parses "tomorrow"', () => {
        const result = parseAction('-> tomorrow', ref);
        assert.equal(result?.targetDate, '2026-04-23');
    });

    it('parses "in 3 days"', () => {
        const result = parseAction('-> in 3 days', ref);
        assert.equal(result?.targetDate, '2026-04-25');
    });

    it('returns null for non-action text', () => {
        assert.equal(parseAction('just a note', ref), null);
    });

    it('returns null for -> with unparseable text', () => {
        assert.equal(parseAction('-> asdfghjkl', ref), null);
    });

    it('still parses old "Move to MM-DD" format', () => {
        const result = parseAction('-> Move to 05-01', ref);
        assert.equal(result?.targetDate, '2026-05-01');
    });
});

describe('extractActions', () => {
    const ref = new Date('2026-03-30');

    it('extracts action from immediate child, marks parent and action completed', () => {
        const sections: Section[] = [{
            name: 'Work',
            items: [{
                status: 'incomplete',
                text: 'Deploy service',
                children: [{
                    status: 'incomplete',
                    text: '-> Move to 05-01',
                    children: [],
                }],
            }],
        }];

        const result = extractActions(sections, ref);

        // Mutated: parent and action child marked completed
        assert.equal(result.sections[0].items[0].status, 'completed');
        assert.equal(result.sections[0].items[0].children[0].status, 'completed');
        assert.equal(result.sections[0].items[0].children[0].text, '-> Move to 05-01 => 2026-05-01');

        // Action emitted: parent without action child, status incomplete
        assert.equal(result.actions.length, 1);
        assert.deepEqual(result.actions[0], {
            kind: 'addItem',
            targetDate: '2026-05-01',
            sectionName: 'Work',
            item: {
                status: 'incomplete',
                text: 'Deploy service',
                children: [],
            },
        });
    });

    it('preserves ancestor chain for deeply nested action', () => {
        const sections: Section[] = [{
            name: 'Work',
            items: [{
                status: 'incomplete',
                text: 'A',
                children: [{
                    status: 'incomplete',
                    text: 'B',
                    children: [
                        {
                            status: 'incomplete',
                            text: 'C',
                            children: [{
                                status: 'incomplete',
                                text: '-> Move to 06-15',
                                children: [],
                            }],
                        },
                        {
                            status: 'incomplete',
                            text: 'D',
                            children: [],
                        },
                    ],
                }],
            }],
        }];

        const result = extractActions(sections, ref);

        // Mutated: C and action child marked completed, B and A unchanged
        assert.equal(result.sections[0].items[0].status, 'incomplete'); // A
        assert.equal(result.sections[0].items[0].children[0].status, 'incomplete'); // B
        assert.equal(result.sections[0].items[0].children[0].children[0].status, 'completed'); // C
        assert.equal(result.sections[0].items[0].children[0].children[0].children[0].status, 'completed'); // action
        assert.equal(result.sections[0].items[0].children[0].children[0].children[0].text, '-> Move to 06-15 => 2026-06-15');

        // Action: full ancestor chain A -> B -> C (without action child), siblings excluded
        assert.equal(result.actions.length, 1);
        assert.deepEqual(result.actions[0], {
            kind: 'addItem',
            targetDate: '2026-06-15',
            sectionName: 'Work',
            item: {
                status: 'incomplete',
                text: 'A',
                children: [{
                    status: 'incomplete',
                    text: 'B',
                    children: [{
                        status: 'incomplete',
                        text: 'C',
                        children: [],
                    }],
                }],
            },
        });
    });

    it('detects action regardless of checkbox state', () => {
        const sections: Section[] = [{
            name: 'Work',
            items: [{
                status: 'incomplete',
                text: 'Item',
                children: [{
                    status: 'note',
                    text: '-> Move to 07-01',
                    children: [],
                }],
            }],
        }];

        const result = extractActions(sections, ref);

        assert.equal(result.actions.length, 1);
        assert.equal(result.actions[0].targetDate, '2026-07-01');
        assert.equal(result.sections[0].items[0].status, 'completed');
        assert.equal(result.sections[0].items[0].children[0].text, '-> Move to 07-01 => 2026-07-01');
    });

    it('returns unchanged sections when no actions present', () => {
        const sections: Section[] = [{
            name: 'Work',
            items: [{
                status: 'incomplete',
                text: 'Normal item',
                children: [{
                    status: 'incomplete',
                    text: 'Sub item',
                    children: [],
                }],
            }],
        }];

        const result = extractActions(sections, ref);

        assert.equal(result.actions.length, 0);
        assert.equal(result.sections[0].items[0].status, 'incomplete');
        assert.equal(result.sections[0].items[0].children[0].status, 'incomplete');
    });

    it('appends resolved date to NL action text', () => {
        const sections: Section[] = [{
            name: 'Work',
            items: [{
                status: 'incomplete',
                text: 'Review PR',
                children: [{
                    status: 'incomplete',
                    text: '-> next week',
                    children: [],
                }],
            }],
        }];

        const ref = new Date('2026-04-22');
        const result = extractActions(sections, ref);

        assert.equal(result.actions.length, 1);
        // "next week" → "sunday" with forwardDate → nearest upcoming Sunday = 2026-04-26
        assert.equal(result.actions[0].targetDate, '2026-04-26');
        assert.equal(result.sections[0].items[0].children[0].text, '-> next week => 2026-04-26');
        assert.equal(result.sections[0].items[0].children[0].status, 'completed');
    });

    it('leaves -> with unparseable text untouched', () => {
        const sections: Section[] = [{
            name: 'Work',
            items: [{
                status: 'incomplete',
                text: 'Some item',
                children: [{
                    status: 'incomplete',
                    text: '-> asdfghjkl',
                    children: [],
                }],
            }],
        }];

        const ref = new Date('2026-04-22');
        const result = extractActions(sections, ref);

        assert.equal(result.actions.length, 0);
        assert.equal(result.sections[0].items[0].status, 'incomplete');
        assert.equal(result.sections[0].items[0].children[0].status, 'incomplete');
        assert.equal(result.sections[0].items[0].children[0].text, '-> asdfghjkl');
    });
});
