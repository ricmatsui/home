# Action: Move To

## Overview

Add an "action" system to the planner. Actions are special children of todo items that instruct the planner to perform operations during the planning phase. The first action type is "Move to", which moves an item to a specific future day file.

## Action syntax

A child item whose text starts with `-> ` is an action. The checkbox state is irrelevant — any of these are valid action markers:

- `- -> Move to 05-01`
- `- [ ] -> Move to 05-01`
- `- [X] -> Move to 05-01`

The "Move to" action format is: `-> Move to MM-DD`

`MM-DD` resolves to the next upcoming `YYYY-MM-DD`. If the date has already passed this year, it resolves to next year. For example, on `2026-03-30`:
- `-> Move to 05-01` resolves to `2026-05-01`
- `-> Move to 03-15` resolves to `2027-03-15`

## Types

```ts
interface AddItemAction {
    kind: 'addItem';
    targetDate: string;     // YYYY-MM-DD
    sectionName: string;
    item: TodoItem;         // full ancestor chain, direct path only
}

type Action = AddItemAction;
```

## Action extraction pass

A new function `extractActions(sections: Section[], referenceDate: Date): { sections: Section[], actions: Action[] }` runs before `partitionSections`.

It recursively walks every item tree in every section, scanning children at all depths for action markers. When an action child is found:

1. Parse the target date from the action text, resolve `MM-DD` to the next upcoming `YYYY-MM-DD` relative to `referenceDate`.
2. Build the item to move: reconstruct the **direct ancestor chain** from the section root down to the immediate parent of the action child. Each ancestor in the chain contains only the single child on the path — siblings are excluded. The immediate parent has the action child removed from its children. All items in the chain have status set to `incomplete`.
3. Emit an `AddItemAction` with the resolved `targetDate`, the `sectionName` from the containing section, and the ancestor chain as `item`.
4. Mutate the current day's data: mark the action child as `completed`, mark the immediate parent as `completed`.

The returned `sections` (now mutated) flow into `partitionSections`. Since the immediate parent is marked completed, `partitionSections` keeps it in "last". Ancestor items follow normal partition logic — if all their children are now completed/rejected/notes, they will naturally be marked completed by `partitionItem`.

### Example

Given today is `2026-03-30`:

```markdown
# Work

- [ ] Top level
    - [ ] Sub item
        - [ ] -> Move to 05-01
    - [ ] Other sub item
```

After `extractActions`:

**Mutated sections (current day):**
```markdown
# Work

- [ ] Top level
    - [X] Sub item
        - [X] -> Move to 05-01
    - [ ] Other sub item
```

**Actions emitted:**
```ts
[{
    kind: 'addItem',
    targetDate: '2026-05-01',
    sectionName: 'Work',
    item: {
        status: 'incomplete',
        text: 'Top level',
        children: [{
            status: 'incomplete',
            text: 'Sub item',
            children: []
        }]
    }
}]
```

Then `partitionSections` processes the mutated sections normally. "Top level" still has an incomplete child ("Other sub item"), so it carries forward. "Sub item" (completed) stays in "last".

### Example: deep nesting

```markdown
# Work

- [ ] A
    - [ ] B
        - [ ] C
            - [ ] -> Move to 06-15
        - [ ] D
```

**Actions emitted:**
```ts
[{
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
                children: []
            }]
        }]
    }
}]
```

Siblings "D" is not included. In the mutated current day, "C" and its action child are marked completed. "B" still has incomplete child "D", so it carries forward normally.

## Action processing in the workflow

After `partitionSections`, the workflow processes each action:

1. Find or create the target day file using `findDayFilePath` / `createDayFile`.
2. Read and parse the target day file with `parseDayFile`.
3. Merge the item into the matching section by name (or create the section if it doesn't exist).
4. Write the target day file with `writeDayFile`.

Multiple actions targeting the same day file should be batched — read/parse once, merge all items, write once.

## Files changed

- `src/types.ts` — Add `AddItemAction`, `Action` types
- `src/lib.ts` — Add `extractActions` function and `resolveNextDate` helper
- `src/index.ts` — Insert action extraction step before partitioning, add action processing step after partitioning
