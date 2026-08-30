import { useCallback, useEffect, useState } from 'react';
import { completeChore, getChores } from '../api/donetick';
import { dueChores } from '../lib/chores';
import { SessionExpiredError } from '../lib/errors';
import type { Chore, RowStatus } from '../types';

const defaultClock = () => new Date();

export function useChores(now: () => Date = defaultClock) {
    const [chores, setChores] = useState<Chore[]>([]);
    const [rowStatus, setRowStatus] = useState<Record<number, RowStatus>>({});
    const [rowError, setRowError] = useState<Record<number, string>>({});
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

    const complete = useCallback(async (id: number) => {
        setRowStatus((current) => ({ ...current, [id]: 'pending' }));
        setRowError((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });

        try {
            await completeChore(id);
            setRowStatus((current) => ({ ...current, [id]: 'done' }));
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

    return { chores, rowStatus, rowError, loading, error, refresh, complete };
}
