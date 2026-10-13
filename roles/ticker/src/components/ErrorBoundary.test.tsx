import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Broken(): never {
    throw new Error("Cannot read properties of undefined (reading 'trim')");
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
    it('renders its children when nothing throws', () => {
        render(
            <ErrorBoundary>
                <p>Board</p>
            </ErrorBoundary>,
        );

        expect(screen.getByText('Board')).toBeInTheDocument();
    });

    it('shows what broke instead of a blank page, and reloads on request', async () => {
        // React reports a caught render error to the console as well.
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const reload = vi.fn();
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: { ...window.location, reload },
        });

        render(
            <ErrorBoundary>
                <Broken />
            </ErrorBoundary>,
        );

        expect(screen.getByRole('alert')).toHaveTextContent(
            "Something broke: Cannot read properties of undefined (reading 'trim')",
        );

        await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
        expect(reload).toHaveBeenCalledOnce();
    });
});
