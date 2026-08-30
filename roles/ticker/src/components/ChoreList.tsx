import { ChoreRow } from './ChoreRow';
import type { Chore, RowStatus } from '../types';

type ChoreListProps = {
    chores: Chore[];
    rowStatus: Record<number, RowStatus>;
    rowError: Record<number, string>;
    now: Date;
    // What an empty list means depends on what was filtered out of it, and
    // only the caller knows that.
    emptyMessage: string;
    onComplete: (id: number) => void;
};

export function ChoreList({
    chores,
    rowStatus,
    rowError,
    now,
    emptyMessage,
    onComplete,
}: ChoreListProps) {
    if (chores.length === 0) {
        return <p className="empty">{emptyMessage}</p>;
    }

    return (
        <ul className="list">
            {chores.map((chore) => (
                <ChoreRow
                    key={chore.id}
                    chore={chore}
                    status={rowStatus[chore.id] ?? 'idle'}
                    error={rowError[chore.id]}
                    now={now}
                    onComplete={onComplete}
                />
            ))}
        </ul>
    );
}
