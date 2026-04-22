# NL Date Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace rigid `-> Move to MM-DD` action syntax with chrono-node natural language date parsing so users can write `-> thursday`, `-> next week`, `-> may`, etc.

**Architecture:** A pre-processing layer normalizes inputs chrono-node can't handle (bare month names, "next week" → "next sunday"), then chrono-node parses the date with `forwardDate: true`. The resolved date is appended to the completed action text as `=> YYYY-MM-DD`.

**Tech Stack:** chrono-node (npm), Node.js test runner, TypeScript

**Spec:** `docs/superpowers/specs/2026-04-22-nl-date-parsing-design.md`

---

### Task 1: Add chrono-node dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install chrono-node**

Run: `npm install chrono-node`

- [ ] **Step 2: Verify it installed**

Run: `node -e "import('chrono-node').then(c => console.log(typeof c.parseDate))"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add chrono-node dependency for NL date parsing"
```

---

### Task 2: Implement parseAction with chrono-node and pre-processing

**Files:**
- Modify: `src/lib.ts:18-38`
- Test: `src/lib.test.ts`

- [ ] **Step 1: Write failing tests for parseAction**

Replace the `resolveNextDate` describe block in `src/lib.test.ts` with:

```typescript
import { parseAction, extractActions } from './lib.js';
```

(Remove the `resolveNextDate` import.)

Then replace the `describe('resolveNextDate', ...)` block with:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `parseAction` is not exported / doesn't exist yet.

- [ ] **Step 3: Implement parseAction**

In `src/lib.ts`, replace lines 18-38 (the `resolveNextDate` function, `ACTION_PATTERN`, and old `parseAction`) with:

```typescript
import * as chrono from 'chrono-node';

const ACTION_PREFIX = '-> ';

const MONTH_NAMES = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
];

function preprocessActionInput(input: string): string {
    const lower = input.toLowerCase().trim();

    // "next week" → "next sunday"
    if (lower === 'next week') return 'next sunday';

    // Bare month name → "{month} 1st"
    if (MONTH_NAMES.includes(lower)) return `${lower} 1st`;

    return input;
}

export function parseAction(
    text: string,
    referenceDate: Date,
): { kind: 'moveTo'; targetDate: string } | null {
    if (!text.startsWith(ACTION_PREFIX)) return null;

    const input = text.slice(ACTION_PREFIX.length).trim();
    if (!input) return null;

    const preprocessed = preprocessActionInput(input);
    const parsed = chrono.parseDate(preprocessed, referenceDate, { forwardDate: true });
    if (!parsed) return null;

    return { kind: 'moveTo', targetDate: formatDateStr(parsed) };
}
```

Also update the export in the file: remove `resolveNextDate` from anywhere it's exported (it's used in tests and in `extractActionsFromItem`).

- [ ] **Step 4: Update extractActionsFromItem to use new parseAction**

In `extractActionsFromItem`, replace the body of the `if (parsed)` block. The function currently calls `resolveNextDate(parsed.mmdd, referenceDate)` — change it to use `parsed.targetDate` directly since `parseAction` now returns the resolved date. The updated function:

```typescript
function extractActionsFromItem(
    item: TodoItem,
    ancestors: TodoItem[],
    sectionName: string,
    referenceDate: Date,
    actions: Action[],
): void {
    const path = [...ancestors, item];

    for (const child of item.children) {
        const parsed = parseAction(child.text, referenceDate);
        if (parsed) {
            const cloned = cloneAncestorChain(path, []);
            actions.push({ kind: 'addItem', targetDate: parsed.targetDate, sectionName, item: cloned });
            child.text = `${child.text} => ${parsed.targetDate}`;
            child.status = 'completed';
            item.status = 'completed';
        } else {
            extractActionsFromItem(child, path, sectionName, referenceDate, actions);
        }
    }
}
```

Key changes:
- `parseAction(child.text, referenceDate)` instead of `parseAction(child.text)` — now takes reference date
- `parsed.targetDate` instead of `resolveNextDate(parsed.mmdd, referenceDate)`
- `child.text = \`${child.text} => ${parsed.targetDate}\`` — appends resolved date

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib.ts src/lib.test.ts
git commit -m "feat: replace rigid MM-DD parsing with chrono-node NL date parsing"
```

---

### Task 3: Update extractActions tests for resolved date suffix

**Files:**
- Modify: `src/lib.test.ts`

- [ ] **Step 1: Update extractActions tests to verify => suffix**

In the `extractActions` describe block, update the existing tests. The action child's text should now include the resolved date suffix.

In the "extracts action from immediate child" test, update the assertion for the action child's text:

```typescript
assert.equal(result.sections[0].items[0].children[0].text, '-> Move to 05-01 => 2026-05-01');
```

In the "preserves ancestor chain" test:

```typescript
assert.equal(result.sections[0].items[0].children[0].children[0].children[0].text, '-> Move to 06-15 => 2026-06-15');
```

In the "detects action regardless of checkbox state" test:

```typescript
assert.equal(result.sections[0].items[0].children[0].text, '-> Move to 07-01 => 2026-07-01');
```

- [ ] **Step 2: Add a test for NL action text with resolved suffix**

Add to the `extractActions` describe block:

```typescript
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
    // "next week" → next sunday = 2026-04-26
    assert.equal(result.actions[0].targetDate, '2026-04-26');
    assert.equal(result.sections[0].items[0].children[0].text, '-> next week => 2026-04-26');
    assert.equal(result.sections[0].items[0].children[0].status, 'completed');
});
```

- [ ] **Step 3: Add a test for unparseable -> text left untouched**

```typescript
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
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib.test.ts
git commit -m "test: update extractActions tests for resolved date suffix and NL inputs"
```

---

### Task 4: Clean up old exports

**Files:**
- Modify: `src/lib.ts`

- [ ] **Step 1: Remove resolveNextDate export**

`resolveNextDate` is no longer used. It was already replaced in Task 2, but verify it's fully removed from `src/lib.ts`. If there are any remaining references, remove them.

- [ ] **Step 2: Ensure parseAction is exported**

Verify `parseAction` has the `export` keyword since tests import it.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: No TypeScript errors.

- [ ] **Step 5: Commit (if any changes)**

```bash
git add src/lib.ts
git commit -m "refactor: remove resolveNextDate, export parseAction"
```
