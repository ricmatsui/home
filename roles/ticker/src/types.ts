export type Chore = {
    id: number;
    name: string;
    nextDueDate: string | null;
    isActive: boolean;
    priority: number;
    // Donetick's per-chore visibility. Private means only its owner sees it
    // in Donetick; everything else is visible to the whole circle.
    isPrivate: boolean;
};

export type RowStatus = 'idle' | 'pending' | 'done' | 'error';
