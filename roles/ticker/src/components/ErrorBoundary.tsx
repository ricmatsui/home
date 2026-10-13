import { Component, type ReactNode } from 'react';

type ErrorBoundaryProps = {
    children: ReactNode;
};

type ErrorBoundaryState = {
    error: Error | null;
};

/*
 * A render that throws unmounts the whole tree, and on the wall tablet that
 * leaves a blank page nobody can tell from a dead screen. This keeps the
 * header up and says what broke.
 *
 * Reload rather than Retry: a render error comes from the data, and
 * re-rendering the same data throws again. A reload fetches afresh, which is
 * the only thing with a chance of drawing something different.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }

    render() {
        const { error } = this.state;
        if (!error) {
            return this.props.children;
        }

        return (
            <main className="app">
                <header className="header">
                    <h1 className="header__title">Tasks</h1>
                </header>
                <div className="banner" role="alert">
                    <p className="banner__message">Something broke: {error.message}</p>
                    <button
                        type="button"
                        className="banner__action"
                        onClick={() => window.location.reload()}
                    >
                        Reload
                    </button>
                </div>
            </main>
        );
    }
}
