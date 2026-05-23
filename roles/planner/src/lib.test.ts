import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAction, extractActions } from './lib.js';
import { Section } from './types.js';

describe('parseAction', () => {
    const ref = new Date(2026, 3, 22);

    it('parses weekday name', () => {
        assert.deepEqual(parseAction('-> thursday', ref), {
            kind: 'moveTo',
            targetDate: '2026-04-23',
        });
    });

    it('parses "next thursday"', () => {
        assert.deepEqual(parseAction('-> next thursday', ref), {
            kind: 'moveTo',
            targetDate: '2026-04-30',
        });
    });

    it('parses "next week" as next sunday', () => {
        assert.deepEqual(parseAction('-> next week', ref), {
            kind: 'moveTo',
            targetDate: '2026-04-26',
        });
    });

    it('parses bare month name to 1st of that month, forward-looking', () => {
        assert.deepEqual(parseAction('-> may', ref), {
            kind: 'moveTo',
            targetDate: '2026-05-01',
        });
    });

    it('parses bare month name past current month to next year', () => {
        assert.deepEqual(parseAction('-> january', ref), {
            kind: 'moveTo',
            targetDate: '2027-01-01',
        });
    });

    it('parses MM-DD format', () => {
        assert.deepEqual(parseAction('-> 05-01', ref), {
            kind: 'moveTo',
            targetDate: '2026-05-01',
        });
    });

    it('parses full date', () => {
        assert.deepEqual(parseAction('-> 2026-12-25', ref), {
            kind: 'moveTo',
            targetDate: '2026-12-25',
        });
    });

    it('parses "tomorrow"', () => {
        assert.deepEqual(parseAction('-> tomorrow', ref), {
            kind: 'moveTo',
            targetDate: '2026-04-23',
        });
    });

    it('parses "in 3 days"', () => {
        assert.deepEqual(parseAction('-> in 3 days', ref), {
            kind: 'moveTo',
            targetDate: '2026-04-25',
        });
    });

    it('parses weekday name to next week when ref is that same weekday', () => {
        // ref is a Monday → "-> monday" should give NEXT Monday, not the same day
        const monday = new Date(2026, 3, 27); // April 27, 2026 is a Monday
        assert.deepEqual(parseAction('-> monday', monday), {
            kind: 'moveTo',
            targetDate: '2026-05-04',
        });
    });

    it('returns null for non-action text', () => {
        assert.equal(parseAction('just a note', ref), null);
    });

    it('returns null for -> with unparseable text', () => {
        assert.equal(parseAction('-> asdfghjkl', ref), null);
    });

});

describe('extractActions', () => {
    const ref = new Date(2026, 2, 30);

    it('extracts action from immediate child, marks parent and action completed', () => {
        const sections: Section[] = [{
            name: 'Work',
            items: [{
                status: 'incomplete',
                text: 'Deploy service',
                children: [{
                    status: 'incomplete',
                    text: '-> 05-01',
                    children: [],
                }],
            }],
        }];

        assert.deepEqual(extractActions(sections, ref), {
            sections: [{
                name: 'Work',
                items: [{
                    status: 'completed',
                    text: 'Deploy service',
                    children: [{
                        status: 'completed',
                        text: '-> 05-01 => 2026-05-01',
                        children: [],
                    }],
                }],
            }],
            actions: [{
                kind: 'addItem',
                targetDate: '2026-05-01',
                sectionName: 'Work',
                item: {
                    status: 'incomplete',
                    text: 'Deploy service',
                    children: [],
                },
            }],
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
                                text: '-> 06-15',
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

        assert.deepEqual(extractActions(sections, ref), {
            sections: [{
                name: 'Work',
                items: [{
                    status: 'incomplete',
                    text: 'A',
                    children: [{
                        status: 'incomplete',
                        text: 'B',
                        children: [
                            {
                                status: 'completed',
                                text: 'C',
                                children: [{
                                    status: 'completed',
                                    text: '-> 06-15 => 2026-06-15',
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
            }],
            actions: [{
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
            }],
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
                    text: '-> 07-01',
                    children: [],
                }],
            }],
        }];

        assert.deepEqual(extractActions(sections, ref), {
            sections: [{
                name: 'Work',
                items: [{
                    status: 'completed',
                    text: 'Item',
                    children: [{
                        status: 'completed',
                        text: '-> 07-01 => 2026-07-01',
                        children: [],
                    }],
                }],
            }],
            actions: [{
                kind: 'addItem',
                targetDate: '2026-07-01',
                sectionName: 'Work',
                item: {
                    status: 'incomplete',
                    text: 'Item',
                    children: [],
                },
            }],
        });
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

        assert.deepEqual(extractActions(sections, ref), {
            sections: [{
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
            }],
            actions: [],
        });
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

        const ref = new Date(2026, 3, 22);

        assert.deepEqual(extractActions(sections, ref), {
            sections: [{
                name: 'Work',
                items: [{
                    status: 'completed',
                    text: 'Review PR',
                    children: [{
                        status: 'completed',
                        text: '-> next week => 2026-04-26',
                        children: [],
                    }],
                }],
            }],
            actions: [{
                kind: 'addItem',
                targetDate: '2026-04-26',
                sectionName: 'Work',
                item: {
                    status: 'incomplete',
                    text: 'Review PR',
                    children: [],
                },
            }],
        });
    });

    it('moves actioned top-level items to end of section, sorted by earliest target date ascending', () => {
        const sections: Section[] = [{
            name: 'Work',
            items: [
                {
                    status: 'incomplete',
                    text: 'A - moved to may',
                    children: [{
                        status: 'incomplete',
                        text: '-> may',
                        children: [],
                    }],
                },
                {
                    status: 'incomplete',
                    text: 'B - stays',
                    children: [],
                },
                {
                    status: 'incomplete',
                    text: 'C - moved to thursday',
                    children: [{
                        status: 'incomplete',
                        text: '-> thursday',
                        children: [],
                    }],
                },
                {
                    status: 'incomplete',
                    text: 'D - stays',
                    children: [],
                },
            ],
        }];

        const ref = new Date(2026, 3, 22); // April 22, 2026

        assert.deepEqual(extractActions(sections, ref), {
            sections: [{
                name: 'Work',
                items: [
                    {
                        status: 'incomplete',
                        text: 'B - stays',
                        children: [],
                    },
                    {
                        status: 'incomplete',
                        text: 'D - stays',
                        children: [],
                    },
                    {
                        status: 'completed',
                        text: 'C - moved to thursday',
                        children: [{
                            status: 'completed',
                            text: '-> thursday => 2026-04-23',
                            children: [],
                        }],
                    },
                    {
                        status: 'completed',
                        text: 'A - moved to may',
                        children: [{
                            status: 'completed',
                            text: '-> may => 2026-05-01',
                            children: [],
                        }],
                    },
                ],
            }],
            actions: [
                {
                    kind: 'addItem',
                    targetDate: '2026-05-01',
                    sectionName: 'Work',
                    item: {
                        status: 'incomplete',
                        text: 'A - moved to may',
                        children: [],
                    },
                },
                {
                    kind: 'addItem',
                    targetDate: '2026-04-23',
                    sectionName: 'Work',
                    item: {
                        status: 'incomplete',
                        text: 'C - moved to thursday',
                        children: [],
                    },
                },
            ],
        });
    });

    it('sorts actioned items by earliest target date when item has multiple actions', () => {
        const sections: Section[] = [{
            name: 'Work',
            items: [
                {
                    status: 'incomplete',
                    text: 'Late move',
                    children: [{
                        status: 'incomplete',
                        text: '-> june',
                        children: [],
                    }],
                },
                {
                    status: 'incomplete',
                    text: 'Multi move',
                    children: [
                        {
                            status: 'incomplete',
                            text: 'Sub A',
                            children: [{
                                status: 'incomplete',
                                text: '-> december',
                                children: [],
                            }],
                        },
                        {
                            status: 'incomplete',
                            text: 'Sub B',
                            children: [{
                                status: 'incomplete',
                                text: '-> april',
                                children: [],
                            }],
                        },
                    ],
                },
            ],
        }];

        const ref = new Date(2026, 2, 30); // March 30, 2026

        assert.deepEqual(extractActions(sections, ref), {
            sections: [{
                name: 'Work',
                items: [
                    {
                        status: 'incomplete',
                        text: 'Multi move',
                        children: [
                            {
                                status: 'completed',
                                text: 'Sub A',
                                children: [{
                                    status: 'completed',
                                    text: '-> december => 2026-12-01',
                                    children: [],
                                }],
                            },
                            {
                                status: 'completed',
                                text: 'Sub B',
                                children: [{
                                    status: 'completed',
                                    text: '-> april => 2026-04-01',
                                    children: [],
                                }],
                            },
                        ],
                    },
                    {
                        status: 'completed',
                        text: 'Late move',
                        children: [{
                            status: 'completed',
                            text: '-> june => 2026-06-01',
                            children: [],
                        }],
                    },
                ],
            }],
            actions: [
                {
                    kind: 'addItem',
                    targetDate: '2026-06-01',
                    sectionName: 'Work',
                    item: {
                        status: 'incomplete',
                        text: 'Late move',
                        children: [],
                    },
                },
                {
                    kind: 'addItem',
                    targetDate: '2026-12-01',
                    sectionName: 'Work',
                    item: {
                        status: 'incomplete',
                        text: 'Multi move',
                        children: [{
                            status: 'incomplete',
                            text: 'Sub A',
                            children: [],
                        }],
                    },
                },
                {
                    kind: 'addItem',
                    targetDate: '2026-04-01',
                    sectionName: 'Work',
                    item: {
                        status: 'incomplete',
                        text: 'Multi move',
                        children: [{
                            status: 'incomplete',
                            text: 'Sub B',
                            children: [],
                        }],
                    },
                },
            ],
        });
    });

    it('includes non-action siblings of the action in the moved clone', () => {
        const sections: Section[] = [{
            name: 'Work',
            items: [{
                status: 'incomplete',
                text: 'Deploy service',
                children: [
                    { status: 'note', text: 'some deployment notes', children: [] },
                    { status: 'incomplete', text: 'step 1', children: [] },
                    { status: 'incomplete', text: '-> 05-01', children: [] },
                ],
            }],
        }];

        assert.deepEqual(extractActions(sections, ref), {
            sections: [{
                name: 'Work',
                items: [{
                    status: 'completed',
                    text: 'Deploy service',
                    children: [{
                        status: 'completed',
                        text: '-> 05-01 => 2026-05-01',
                        children: [],
                    }],
                }],
            }],
            actions: [{
                kind: 'addItem',
                targetDate: '2026-05-01',
                sectionName: 'Work',
                item: {
                    status: 'incomplete',
                    text: 'Deploy service',
                    children: [
                        { status: 'note', text: 'some deployment notes', children: [] },
                        { status: 'incomplete', text: 'step 1', children: [] },
                    ],
                },
            }],
        });
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

        const ref = new Date(2026, 3, 22);

        assert.deepEqual(extractActions(sections, ref), {
            sections: [{
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
            }],
            actions: [],
        });
    });
});
