import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNextDate, extractActions } from './lib.js';
import { Section } from './types.js';

describe('resolveNextDate', () => {
    it('resolves future date in same year', () => {
        const ref = new Date('2026-03-30');
        assert.equal(resolveNextDate('05-01', ref), '2026-05-01');
    });

    it('resolves past date to next year', () => {
        const ref = new Date('2026-03-30');
        assert.equal(resolveNextDate('03-15', ref), '2027-03-15');
    });

    it('resolves same day to next year', () => {
        const ref = new Date('2026-03-30');
        assert.equal(resolveNextDate('03-30', ref), '2027-03-30');
    });

    it('resolves Dec date from Jan reference', () => {
        const ref = new Date('2027-01-05');
        assert.equal(resolveNextDate('12-25', ref), '2027-12-25');
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
});
