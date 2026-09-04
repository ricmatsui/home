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
};

export type RowStatus = 'idle' | 'pending' | 'done' | 'error';
