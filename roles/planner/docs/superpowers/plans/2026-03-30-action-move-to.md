# Action: Move To — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Move to" action that relocates todo items to a specific future day file during the planning phase.

**Architecture:** A new `extractActions` pass runs before `partitionSections`, mutating sections (marking action parents/children as completed) and emitting action commands. The workflow then processes these commands by writing items to target day files. Actions preserve the full ancestor chain (direct path only) when moving items.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node --test`), existing DBOS workflow system.

---

## File Structure

- **`src/types.ts`** — Add `AddItemAction` and `Action` types
- **`src/lib.ts`** — Add `resolveNextDate` helper and `extractActions` function
- **`src/index.ts`** — Wire action extraction before partitioning, add action processing step after partitioning
- **`src/lib.test.ts`** — Tests for `resolveNextDate` and `extractActions`

---

### Task 1: Add Action Types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add action types to `src/types.ts`**

Append after the `Section` interface:

```ts
export interface AddItemAction {
    kind: 'addItem';
    targetDate: string;
    sectionName: string;
    item: TodoItem;
}

export type Action = AddItemAction;
```

- [ ] **Step 2: Build to verify types compile**

Run: `yarn build`
Expected: Success, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add Action types for move-to support"
```

---

### Task 2: Implement `resolveNextDate`

**Files:**
- Create: `src/lib.test.ts`
- Modify: `src/lib.ts`

- [ ] **Step 1: Write the failing test for `resolveNextDate`**

Create `src/lib.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNextDate } from './lib.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn build && node --test dist/lib.test.js`
Expected: FAIL — `resolveNextDate` is not exported from `./lib.js`.

- [ ] **Step 3: Implement `resolveNextDate` in `src/lib.ts`**

Add before the `export async function unlockWikiIfPossible` line:

```ts
export function resolveNextDate(mmdd: string, referenceDate: Date): string {
    const [mm, dd] = mmdd.split('-').map(Number);
    const year = referenceDate.getFullYear();
    const candidate = new Date(year, mm - 1, dd);

    if (candidate <= referenceDate) {
        candidate.setFullYear(year + 1);
    }

    return formatDateStr(candidate);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn build && node --test dist/lib.test.js`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib.ts src/lib.test.ts
git commit -m "feat: add resolveNextDate helper"
```

---

### Task 3: Implement `extractActions`

**Files:**
- Modify: `src/lib.test.ts`
- Modify: `src/lib.ts`

- [ ] **Step 1: Write the failing test — shallow action**

Append to `src/lib.test.ts`:

```ts
import { resolveNextDate, extractActions } from './lib.js';
import { TodoItem, Section } from './types.js';

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn build && node --test dist/lib.test.js`
Expected: FAIL — `extractActions` is not exported.

- [ ] **Step 3: Implement `extractActions` in `src/lib.ts`**

Add the following to `src/lib.ts`:

```ts
import { Status, TodoItem, Section, Action } from './types.js';

const ACTION_PATTERN = /^-> Move to (\d{2}-\d{2})$/;

function parseAction(text: string): { kind: 'moveTo'; mmdd: string } | null {
    const match = text.match(ACTION_PATTERN);
    if (!match) return null;
    return { kind: 'moveTo', mmdd: match[1] };
}

function cloneAncestorChain(ancestors: TodoItem[], leafChildren: TodoItem[]): TodoItem {
    let current: TodoItem = {
        status: 'incomplete',
        text: ancestors[ancestors.length - 1].text,
        children: leafChildren,
    };

    for (let i = ancestors.length - 2; i >= 0; i--) {
        current = {
            status: 'incomplete',
            text: ancestors[i].text,
            children: [current],
        };
    }

    return current;
}

function extractActionsFromItem(
    item: TodoItem,
    ancestors: TodoItem[],
    sectionName: string,
    referenceDate: Date,
    actions: Action[],
): void {
    const path = [...ancestors, item];

    for (const child of item.children) {
        const parsed = parseAction(child.text);
        if (parsed) {
            const targetDate = resolveNextDate(parsed.mmdd, referenceDate);
            const cloned = cloneAncestorChain(path, []);
            actions.push({ kind: 'addItem', targetDate, sectionName, item: cloned });
            child.status = 'completed';
            item.status = 'completed';
        } else {
            extractActionsFromItem(child, path, sectionName, referenceDate, actions);
        }
    }
}

export function extractActions(
    sections: Section[],
    referenceDate: Date,
): { sections: Section[]; actions: Action[] } {
    const actions: Action[] = [];

    for (const section of sections) {
        for (const item of section.items) {
            extractActionsFromItem(item, [], section.name, referenceDate, actions);
        }
    }

    return { sections, actions };
}
```

Update the existing import at the top of `src/lib.ts` to include `Action`:

```ts
import { Status, TodoItem, Section, Action } from './types.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn build && node --test dist/lib.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing test — deep nesting with ancestor chain**

Append to the `extractActions` describe block in `src/lib.test.ts`:

```ts
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `yarn build && node --test dist/lib.test.js`
Expected: PASS — the implementation already handles deep nesting.

- [ ] **Step 7: Write the failing test — action with note/checkbox-less syntax**

Append to the `extractActions` describe block:

```ts
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
```

- [ ] **Step 8: Run test to verify it passes**

Run: `yarn build && node --test dist/lib.test.js`
Expected: PASS — `parseAction` only checks text, not status.

- [ ] **Step 9: Write the failing test — no actions returns unchanged sections**

Append to the `extractActions` describe block:

```ts
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
```

- [ ] **Step 10: Run test to verify it passes**

Run: `yarn build && node --test dist/lib.test.js`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/lib.ts src/lib.test.ts
git commit -m "feat: add extractActions with recursive action detection"
```

---

### Task 4: Wire Actions Into the Workflow

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the action extraction step**

In `src/index.ts`, update the import to include `extractActions`:

```ts
import { unlockWikiIfPossible, formatDateStr, readTodoFile, findDayFilePath, createDayFile, parseDayFile, partitionSections, writeDayFile, markDayAsDone, commitWiki, pushWiki, extractActions } from './lib.js';
```

Add the import for `Action`:

```ts
import { Section, Action } from './types.js';
```

Insert a new `DBOS.runStep` after the `sections` step (line 35) and before the `partitionSections` step (line 37). This replaces the existing `const { lastData, nextData }` step:

```ts
    const { processedSections, actions } = await DBOS.runStep(async () => {
        if (!sections) {
            return { processedSections: null, actions: [] as Action[] };
        }

        return extractActions(sections, nextDate);
    });

    const { lastData, nextData } = await DBOS.runStep(async () => {
        if (!processedSections) {
            return { lastData: null, nextData: null };
        }

        return partitionSections(processedSections);
    });
```

- [ ] **Step 2: Add the action processing step**

Insert after the `markDayAsDone` step (line 109) and before the `commitWiki` step (line 111):

```ts
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
```

- [ ] **Step 3: Build to verify compilation**

Run: `yarn build`
Expected: Success, no errors.

- [ ] **Step 4: Run all tests**

Run: `node --test dist/lib.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire action extraction and processing into planner workflow"
```

---

### Task 5: Add `test` Script to `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add test script**

Add to `scripts` in `package.json`:

```json
"test": "tsc && node --test dist/lib.test.js"
```

- [ ] **Step 2: Run it**

Run: `yarn test`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add test script using node built-in test runner"
```
