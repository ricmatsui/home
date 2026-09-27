export type Chore = {
    id: number;
    name: string;
    nextDueDate: string | null;
    isActive: boolean;
    priority: number;
    // Donetick's per-chore visibility. Private means only its owner sees it
    // in Donetick; everything else is visible to the whole circle.
    isPrivate: boolean;
    // Rich HTML from Donetick's Quill editor, not plain text. Always a string
    // — empty when unset, never null. See lib/description.ts.
    description: string;
    // Hours before nextDueDate that the chore becomes completable. Donetick
    // omits the field entirely when unset, so it is absent on most chores.
    completionWindow?: number | null;
    // When Donetick last wrote the chore. It refuses a due date change sent
    // with an older one than it holds.
    updatedAt: string;
};

/*
 * 'picking' is the moment between tapping Done and naming who did it, and
 * 'rescheduling' the moment between tapping the clock and choosing how many
 * days. Nothing has been sent to Donetick in either.
 *
 * 'moving' and 'moved' are a reschedule's own 'pending' and 'done'. Separate
 * rather than shared, because a moved chore is still to do: its buttons stay
 * live, and its hourglass belongs on the clock rather than on Done.
 */
export type RowStatus =
    | 'idle'
    | 'picking'
    | 'pending'
    | 'done'
    | 'rescheduling'
    | 'moving'
    | 'moved'
    | 'error';

/*
 * Somebody a completion can be credited to. `id` is Donetick's `userId` — the
 * value its API takes as `completedBy` — not the membership `id` that
 * /circles/members returns alongside it.
 */
export type User = {
    name: string;
    id: number;
};
