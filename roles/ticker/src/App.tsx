import { ChoreList } from './components/ChoreList';
import { ErrorBanner } from './components/ErrorBanner';
import { PublicFilterButton } from './components/PublicFilterButton';
import { RefreshButton } from './components/RefreshButton';
import { useChores } from './hooks/useChores';
import { useDayRollover } from './hooks/useDayRollover';
import { usePublicOnly } from './hooks/usePublicOnly';
import { filterPublic } from './lib/chores';
import { USERS } from './lib/users';
import type { User } from './types';

type AppProps = {
    // Injected the same way the clock is, so the tests can hand the board a
    // roster without going through the build-time variable it normally
    // comes from.
    users?: User[];
};

export default function App({ users = USERS }: AppProps = {}) {
    const {
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
    } = useChores();
    const { publicOnly, togglePublicOnly } = usePublicOnly();

    useDayRollover(() => window.location.reload());

    // Applied here rather than in useChores: the filter changes what is on
    // screen, not what was fetched, so toggling it must not cost a round trip.
    const visible = publicOnly ? filterPublic(chores) : chores;

    /*
     * Whether Done opens a choice, decided here because this is the only place
     * that can see both halves of it.
     *
     * The filter is the half that is not obvious. Crediting a completion is a
     * question about the household, and the public board — the wall tablet —
     * is where the household answers it. The unfiltered board is somebody
     * looking at their own chores, private ones included, where the second tap
     * would only ever name the person already holding the device.
     *
     * The roster is the older half: one person configured is the same as none,
     * so there is nothing to choose between and Done stays a single tap.
     * Either way an unasked completion goes out unattributed, which is what
     * the board did before any of this existed.
     */
    const asksWhoDidIt = publicOnly && users.length > 1;

    return (
        <main className="app">
            <header className="header">
                <h1 className="header__title">Tasks</h1>
                <div className="header__actions">
                    <PublicFilterButton publicOnly={publicOnly} onToggle={togglePublicOnly} />
                    <RefreshButton onRefresh={() => void refresh()} loading={loading} />
                </div>
            </header>

            {error ? (
                <ErrorBanner
                    error={error}
                    onReload={() => window.location.reload()}
                    onRetry={() => void refresh()}
                />
            ) : null}

            {/*
              * Only render the list once there is something true to say. An
              * empty list mid-load is not the same fact as "nothing due",
              * and neither is an empty list after the load failed.
              */}
            {loading ? (
                <p className="loading">Loading…</p>
            ) : error && chores.length === 0 ? null : (
                <ChoreList
                    chores={visible}
                    rowStatus={rowStatus}
                    rowError={rowError}
                    rowCompletedBy={rowCompletedBy}
                    users={users}
                    asksWhoDidIt={asksWhoDidIt}
                    now={new Date()}
                    // A chore the filter removed is still due, so the empty
                    // list has to say which of the two things it means.
                    emptyMessage={publicOnly ? 'Nothing public due' : 'Nothing due'}
                    onBeginComplete={beginComplete}
                    onCancelComplete={cancelComplete}
                    onComplete={(id, user) => void complete(id, user)}
                />
            )}
        </main>
    );
}
