import { ChoreRow } from './ChoreRow';
import type { Chore, RowStatus, User } from '../types';

type ChoreListProps = {
    chores: Chore[];
    rowStatus: Record<number, RowStatus>;
    rowError: Record<number, string>;
    rowCompletedBy: Record<number, User>;
    users: User[];
    // Passed straight through: the list has no more view of the filter than
    // the row does. See ChoreRow.
    asksWhoDidIt: boolean;
    now: Date;
    // What an empty list means depends on what was filtered out of it, and
    // only the caller knows that.
    emptyMessage: string;
    onBeginComplete: (id: number) => void;
    onCancelComplete: (id: number) => void;
    onComplete: (id: number, user?: User) => void;
};

export function ChoreList({
    chores,
    rowStatus,
    rowError,
    rowCompletedBy,
    users,
    asksWhoDidIt,
    now,
    emptyMessage,
    onBeginComplete,
    onCancelComplete,
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
                    completedBy={rowCompletedBy[chore.id]}
                    users={users}
                    asksWhoDidIt={asksWhoDidIt}
                    now={now}
                    onBeginComplete={onBeginComplete}
                    onCancelComplete={onCancelComplete}
                    onComplete={onComplete}
                />
            ))}
        </ul>
    );
}
