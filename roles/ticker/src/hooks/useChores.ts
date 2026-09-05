import { useCallback, useEffect, useState } from 'react';
import { completeChore, getChores } from '../api/donetick';
import { dueChores } from '../lib/chores';
import { SessionExpiredError } from '../lib/errors';
import type { Chore, RowStatus, User } from '../types';

const defaultClock = () => new Date();

export function useChores(now: () => Date = defaultClock) {
    const [chores, setChores] = useState<Chore[]>([]);
    const [rowStatus, setRowStatus] = useState<Record<number, RowStatus>>({});
    const [rowError, setRowError] = useState<Record<number, string>>({});
    // Who each finished row was credited to. Separate from rowStatus, which
    // says 'done' either way — this is the only record of which person the
    // completion actually went to.
    const [rowCompletedBy, setRowCompletedBy] = useState<Record<number, User>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            const fetched = await getChores();
            setChores(dueChores(fetched, now()));
            // Cleared only once the replacement data is in hand. Clearing up
            // front would un-strike completed rows while the stale list is
            // still on screen.
            setRowStatus({});
            setRowError({});
            setRowCompletedBy({});
        } catch (caught) {
            setError(caught as Error);
        } finally {
            setLoading(false);
        }
    }, [now]);

    useEffect(() => {
        void refresh();
        // Deliberately no focus listener and no interval: refresh is manual only.
    }, [refresh]);

    /*
     * Tapping Done on a board with people configured does not complete
     * anything — it opens the row for a choice. The state lives here rather
     * than in the row so that a refresh clears it along with everything else;
     * kept in the component it would survive the list being replaced.
     */
    const beginComplete = useCallback((id: number) => {
        setRowStatus((current) => ({ ...current, [id]: 'picking' }));
        setRowError((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });
    }, []);

    /*
     * Backing out of the choice. The row returns to 'idle' rather than having
     * its entry deleted so that this reads the same as every other status
     * move — the two are equivalent to the list, which defaults a missing row
     * to 'idle' anyway.
     */
    const cancelComplete = useCallback((id: number) => {
        setRowStatus((current) => ({ ...current, [id]: 'idle' }));
    }, []);

    const complete = useCallback(async (id: number, user?: User) => {
        setRowStatus((current) => ({ ...current, [id]: 'pending' }));
        setRowError((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });

        try {
            await completeChore({ id, completedBy: user?.id });
            setRowStatus((current) => ({ ...current, [id]: 'done' }));
            if (user) {
                setRowCompletedBy((current) => ({ ...current, [id]: user }));
            }
        } catch (caught) {
            // A lapsed session is not a problem with this row — it blocks
            // everything, so it belongs in the global banner.
            if (caught instanceof SessionExpiredError) {
                setError(caught);
                setRowStatus((current) => ({ ...current, [id]: 'idle' }));
                return;
            }
            setRowStatus((current) => ({ ...current, [id]: 'error' }));
            setRowError((current) => ({ ...current, [id]: (caught as Error).message }));
        }
    }, []);

    return {
        chores,
        rowStatus,
        rowError,
        rowCompletedBy,
        loading,
        error,
        refresh,
        beginComplete,
        cancelComplete,
        complete,
    };
}
