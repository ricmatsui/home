# Natural Language Date Parsing for Actions

Replaces the rigid `-> Move to MM-DD` syntax with flexible natural language date parsing using chrono-node.

## Trigger

`->` remains the action trigger prefix. Everything after `->` is treated as natural language input and parsed for a date.

## Date Resolution

- Use chrono-node's `parseDate()` with the reference date (the "next date" already in the system) and `forwardDate: true` so all dates resolve forward.
- The existing `MM-DD` format continues to work since chrono can parse it.

### Pre-processing layer

chrono-node does not natively handle bare month names or start-of-week configuration. A small normalization step runs before chrono:

- **Bare month names** (e.g., "may", "december") — rewritten to "{month} 1st" before passing to chrono. Combined with `forwardDate: true`, this gives correct forward-looking behavior.
- **"next week"** — rewritten to "next sunday" before passing to chrono, since Sunday is the start of the planning week.

### Supported inputs

Anything chrono-node can parse, including:

- `-> thursday`, `-> next thursday`
- `-> may`, `-> may 1st`
- `-> next week` (resolves to next Sunday)
- `-> 05-01`, `-> 2026-05-01`
- `-> tomorrow`, `-> in 3 days`

## Unparseable input

If a line starts with `->` but chrono-node returns null (cannot extract a date), the item is **not** treated as an action. It passes through untouched — not marked completed, not moved. It will carry over to the next day as an incomplete item, signaling to the user that the syntax wasn't recognized.

## Output format

When an action is resolved, the child item is marked completed and the resolved date is appended to its text:

```
- [X] -> next week => 2026-04-26
```

Format: `{original text} => {YYYY-MM-DD}`

## Code changes

### `lib.ts`

- **Remove** `resolveNextDate` — chrono-node handles date resolution directly.
- **Remove** `ACTION_PATTERN` regex.
- **Rewrite `parseAction`** — strip `->` prefix, run pre-processing normalizations (bare months, "next week"), pass result to chrono-node's `parseDate()` with `forwardDate: true`. Return `{ kind: 'moveTo', targetDate: string }` (YYYY-MM-DD) or null.
- **Update `extractActionsFromItem`** — after marking `child.status = 'completed'`, append ` => {targetDate}` to `child.text`.

### `types.ts`

No changes. `Action` and `AddItemAction` remain the same.

### `index.ts`

No changes. It already consumes `action.targetDate` as a YYYY-MM-DD string.

### Dependencies

Add `chrono-node` as a dependency.

### Tests

Update `lib.test.ts`:

- Replace `resolveNextDate` tests with `parseAction` tests covering: "thursday", "next week", "may", "05-01", "tomorrow", unparseable input returning null.
- Update `extractActions` tests to verify the `=> YYYY-MM-DD` suffix is appended to completed action items.
