import { ChoreList } from './components/ChoreList';
import { ErrorBanner } from './components/ErrorBanner';
import { PublicFilterButton } from './components/PublicFilterButton';
import { RefreshButton } from './components/RefreshButton';
import { useChores } from './hooks/useChores';
import { usePublicOnly } from './hooks/usePublicOnly';
import { filterPublic } from './lib/chores';

export default function App() {
    const { chores, rowStatus, rowError, loading, error, refresh, complete } = useChores();
    const { publicOnly, togglePublicOnly } = usePublicOnly();

    // Applied here rather than in useChores: the filter changes what is on
    // screen, not what was fetched, so toggling it must not cost a round trip.
    const visible = publicOnly ? filterPublic(chores) : chores;

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
                    now={new Date()}
                    // A chore the filter removed is still due, so the empty
                    // list has to say which of the two things it means.
                    emptyMessage={publicOnly ? 'Nothing public due' : 'Nothing due'}
                    onComplete={(id) => void complete(id)}
                />
            )}
        </main>
    );
}
