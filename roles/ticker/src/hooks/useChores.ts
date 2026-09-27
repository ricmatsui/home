import { useCallback, useEffect, useState } from 'react';
import { completeChore, getChores, rescheduleChore } from '../api/donetick';
import { postpone, selectDue } from '../lib/chores';
import { SessionExpiredError } from '../lib/errors';
import type { Chore, RowStatus, User } from '../types';

const defaultClock = () => new Date();

export function useChores(now: () => Date = defaultClock) {
    const [dueChores, setDueChores] = useState<Chore[]>([]);
    const [allChores, setAllChores] = useState<Chore[]>([]);
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
            setDueChores(selectDue(fetched, now()));
            setAllChores(fetched);
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

    const clearRowError = useCallback((id: number) => {
        setRowError((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });
    }, []);

    /*
     * A lapsed session is not a problem with this row — it blocks everything,
     * so it belongs in the global banner. A chore that moved on deliberately
     * does not go there: it is one row's problem, and the rest of the board is
     * still tappable.
     */
    const fail = useCallback((id: number, caught: unknown) => {
        if (caught instanceof SessionExpiredError) {
            setError(caught);
            setRowStatus((current) => ({ ...current, [id]: 'idle' }));
            return;
        }
        setRowStatus((current) => ({ ...current, [id]: 'error' }));
        setRowError((current) => ({ ...current, [id]: (caught as Error).message }));
    }, []);

    /*
     * Tapping Done on a board with people configured does not complete
     * anything — it opens the row for a choice. The state lives here rather
     * than in the row so that a refresh clears it along with everything else;
     * kept in the component it would survive the list being replaced.
     */
    const beginComplete = useCallback((id: number) => {
        setRowStatus((current) => ({ ...current, [id]: 'picking' }));
        clearRowError(id);
    }, [clearRowError]);

    /*
     * Backing out of the choice. The row returns to 'idle' rather than having
     * its entry deleted so that this reads the same as every other status
     * move — the two are equivalent to the list, which defaults a missing row
     * to 'idle' anyway.
     */
    const cancelComplete = useCallback((id: number) => {
        setRowStatus((current) => ({ ...current, [id]: 'idle' }));
    }, []);

    /*
     * The due date goes out with the completion so the API client can refuse
     * one whose chore has moved on since the board was drawn. It is read from
     * this hook's own copy of the fetch — the same data the row rendered from,
     * on the board or in search — rather than passed in by the row, so what
     * gets checked is by construction what the person tapping was looking at.
     * The full list rather than the due one, since search can complete a
     * chore the board is not showing.
     */
    const complete = useCallback(
        async (id: number, user?: User) => {
            setRowStatus((current) => ({ ...current, [id]: 'pending' }));
            clearRowError(id);

            try {
                const dueDate = allChores.find((chore) => chore.id === id)?.nextDueDate ?? null;
                await completeChore({ id, dueDate, completedBy: user?.id });
                setRowStatus((current) => ({ ...current, [id]: 'done' }));
                if (user) {
                    setRowCompletedBy((current) => ({ ...current, [id]: user }));
                }
            } catch (caught) {
                fail(id, caught);
            }
        },
        [allChores, clearRowError, fail],
    );

    /*
     * The clock's counterpart to beginComplete: opens the row for how many
     * days, and sends nothing.
     */
    const beginReschedule = useCallback((id: number) => {
        setRowStatus((current) => ({ ...current, [id]: 'rescheduling' }));
        clearRowError(id);
    }, [clearRowError]);

    const cancelReschedule = useCallback((id: number) => {
        setRowStatus((current) => ({ ...current, [id]: 'idle' }));
    }, []);

    /*
     * The new due date is worked out from this hook's copy of the chore, as
     * the completion's check is, and written back into that copy once
     * Donetick has taken it — the 200 is the confirmation. Donetick's reply
     * carries the chore as it was before the change, so it is no use for
     * this.
     *
     * The row stays where it is on the board even when the move takes it past
     * the next day: taking it out would hop every row below it up under a
     * thumb. The next refresh drops it.
     */
    const reschedule = useCallback(
        async (id: number, days: number) => {
            const dueDate = allChores.find((chore) => chore.id === id)?.nextDueDate;
            // The clock is disabled on an undated chore; there is nothing to
            // count the days from.
            if (!dueDate) {
                return;
            }

            setRowStatus((current) => ({ ...current, [id]: 'moving' }));
            clearRowError(id);

            try {
                const nextDueDate = postpone(dueDate, days, now());
                await rescheduleChore({ id, dueDate, nextDueDate });
                const move = (chores: Chore[]) =>
                    chores.map((chore) => (chore.id === id ? { ...chore, nextDueDate } : chore));
                setAllChores(move);
                setDueChores(move);
                setRowStatus((current) => ({ ...current, [id]: 'moved' }));
            } catch (caught) {
                fail(id, caught);
            }
        },
        [allChores, now, clearRowError, fail],
    );

    return {
        dueChores,
        allChores,
        rowStatus,
        rowError,
        rowCompletedBy,
        loading,
        error,
        refresh,
        beginComplete,
        cancelComplete,
        complete,
        beginReschedule,
        cancelReschedule,
        reschedule,
    };
}
