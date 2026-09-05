import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import * as api from './api/donetick';
import { ApiError, NetworkError, SessionExpiredError } from './lib/errors';
import { TICK_MS } from './hooks/useDayRollover';
import type { Chore, User } from './types';

function chore(overrides: Partial<Chore> = {}): Chore {
    return {
        id: 1,
        name: 'Trash',
        nextDueDate: '2026-08-10T12:00:00Z',
        isActive: true,
        priority: 0,
        isPrivate: false,
        description: '',
        ...overrides,
    };
}

beforeEach(() => {
    localStorage.clear();
    vi.spyOn(api, 'getChores').mockResolvedValue([]);
    vi.spyOn(api, 'completeChore').mockResolvedValue(undefined);
    // jsdom refuses to navigate, so the real reload only logs a "not
    // implemented" error. Replacing it makes the call observable instead.
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, reload: vi.fn() },
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const HOUR = 60 * 60 * 1000;

const JANE: User = { name: 'Jane', id: 1 };
const JOHN: User = { name: 'John', id: 2 };

describe('App', () => {
    it('lists overdue chores with how late they are', async () => {
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 1, name: 'Refill Tires' })]);

        render(<App />);

        expect(await screen.findByText('Refill Tires')).toBeInTheDocument();
        expect(screen.getByText(/ago$/)).toBeInTheDocument();
    });

    it('lists a chore that is not due yet with the time remaining', async () => {
        vi.mocked(api.getChores).mockResolvedValue([
            chore({
                id: 1,
                name: 'Water Plants',
                // A minute of slack so the render clock, which ticks after
                // this line, still lands inside the fifth hour.
                nextDueDate: new Date(Date.now() + 5 * HOUR + 60_000).toISOString(),
            }),
        ]);

        render(<App />);

        expect(await screen.findByText('Water Plants')).toBeInTheDocument();
        expect(screen.getByText('in 5 hours')).toBeInTheDocument();
    });

    it('leaves out a chore due beyond the next day', async () => {
        vi.mocked(api.getChores).mockResolvedValue([
            chore({
                id: 1,
                name: 'Change Filter',
                nextDueDate: new Date(Date.now() + 48 * HOUR).toISOString(),
            }),
        ]);

        render(<App />);

        expect(await screen.findByText(/nothing due/i)).toBeInTheDocument();
        expect(screen.queryByText('Change Filter')).not.toBeInTheDocument();
    });

    /*
     * Donetick answers a completion made before the window opens with a 400,
     * so listing one offers a Done button that can only fail.
     */
    it('leaves out a chore whose completion window has not opened yet', async () => {
        vi.mocked(api.getChores).mockResolvedValue([
            chore({
                id: 1,
                name: 'Weekly Finances',
                nextDueDate: new Date(Date.now() + 5 * HOUR).toISOString(),
                completionWindow: 1,
            }),
        ]);

        render(<App />);

        expect(await screen.findByText(/nothing due/i)).toBeInTheDocument();
        expect(screen.queryByText('Weekly Finances')).not.toBeInTheDocument();
    });

    it('lists a chore whose completion window is already open', async () => {
        vi.mocked(api.getChores).mockResolvedValue([
            chore({
                id: 1,
                name: 'Weekly Finances',
                nextDueDate: new Date(Date.now() + 5 * HOUR).toISOString(),
                completionWindow: 24,
            }),
        ]);

        render(<App />);

        expect(await screen.findByText('Weekly Finances')).toBeInTheDocument();
    });

    // The button is a bare checkmark, so its accessible name is the only
    // thing telling a screen reader which of four identical buttons this is.
    it('names the completion button after its chore', async () => {
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 42, name: 'Refill Tires' })]);

        render(<App />);

        expect(
            await screen.findByRole('button', { name: 'Mark Refill Tires done' }),
        ).toBeInTheDocument();
    });

    it('completes a chore and crosses the row off', async () => {
        const user = userEvent.setup();
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 42, name: 'Trash' })]);

        render(<App />);
        const item = await screen.findByRole('listitem');

        await user.click(within(item).getByRole('button', { name: /done/i }));

        await waitFor(() => expect(item).toHaveAttribute('data-status', 'done'));
        expect(api.completeChore).toHaveBeenCalledWith({ id: 42, completedBy: undefined });
    });

    it('does not cross the row off until the API resolves', async () => {
        const user = userEvent.setup();
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 42 })]);

        let resolveCompletion: () => void = () => {};
        vi.mocked(api.completeChore).mockReturnValue(
            new Promise<void>((resolve) => {
                resolveCompletion = resolve;
            }),
        );

        render(<App />);
        const item = await screen.findByRole('listitem');
        await user.click(within(item).getByRole('button', { name: /done/i }));

        await waitFor(() => expect(item).toHaveAttribute('data-status', 'pending'));
        expect(within(item).getByRole('button')).toBeDisabled();

        resolveCompletion();
        await waitFor(() => expect(item).toHaveAttribute('data-status', 'done'));
    });

    // Dimming alone was too quiet: a faded button reads as "unavailable"
    // rather than "working on it". The glyph is what carries the state.
    it('swaps the checkmark for an hourglass while the completion is in flight', async () => {
        const user = userEvent.setup();
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 42 })]);

        let resolveCompletion: () => void = () => {};
        vi.mocked(api.completeChore).mockReturnValue(
            new Promise<void>((resolve) => {
                resolveCompletion = resolve;
            }),
        );

        render(<App />);
        const item = await screen.findByRole('listitem');
        await user.click(within(item).getByRole('button', { name: /done/i }));

        const button = within(item).getByRole('button');
        await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'true'));
        expect(button.querySelector('[data-icon="hourglass"]')).toBeInTheDocument();
        expect(button.querySelector('[data-icon="check"]')).not.toBeInTheDocument();

        resolveCompletion();

        await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'false'));
        expect(button.querySelector('[data-icon="check"]')).toBeInTheDocument();
    });

    it('shows the API message and keeps the row actionable when completion fails', async () => {
        const user = userEvent.setup();
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 42 })]);
        vi.mocked(api.completeChore).mockRejectedValue(
            new ApiError(400, 'Chore is out of completion window'),
        );

        render(<App />);
        const item = await screen.findByRole('listitem');
        await user.click(within(item).getByRole('button', { name: /done/i }));

        expect(
            await within(item).findByText('Chore is out of completion window'),
        ).toBeInTheDocument();
        expect(within(item).getByRole('button', { name: /done/i })).toBeEnabled();
    });

    describe('crediting a person', () => {
        it('asks who did it, and sends nothing until it is told', async () => {
            vi.mocked(api.getChores).mockResolvedValue([chore({ id: 1, name: 'Trash' })]);

            render(<App users={[JANE, JOHN]} />);
            await userEvent.click(await screen.findByRole('button', { name: 'Mark Trash done' }));

            expect(screen.getByRole('button', { name: 'Mark Trash done as John' })).toBeInTheDocument();
            expect(api.completeChore).not.toHaveBeenCalled();
        });

        it('completes as the person tapped and says so on the finished row', async () => {
            vi.mocked(api.getChores).mockResolvedValue([chore({ id: 1, name: 'Trash' })]);

            render(<App users={[JANE, JOHN]} />);
            await userEvent.click(await screen.findByRole('button', { name: 'Mark Trash done' }));
            await userEvent.click(
                screen.getByRole('button', { name: 'Mark Trash done as John' }),
            );

            // 2 is John's Donetick userId, which is what completedBy takes.
            await waitFor(() => expect(api.completeChore).toHaveBeenCalledWith({ id: 1, completedBy: 2 }));
            expect(await screen.findByText('Done · John')).toBeInTheDocument();
        });

        it('leaves the board a single tap when nobody is configured', async () => {
            vi.mocked(api.getChores).mockResolvedValue([chore({ id: 1, name: 'Trash' })]);

            render(<App />);
            await userEvent.click(await screen.findByRole('button', { name: 'Mark Trash done' }));

            await waitFor(() => expect(api.completeChore).toHaveBeenCalledWith({ id: 1, completedBy: undefined }));
        });
    });

    it('shows a session-expired banner with a reload action', async () => {
        vi.mocked(api.getChores).mockRejectedValue(new SessionExpiredError());

        render(<App />);

        expect(await screen.findByRole('alert')).toHaveTextContent(/session expired/i);
        expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    });

    it('shows a distinct message when the server is unreachable', async () => {
        vi.mocked(api.getChores).mockRejectedValue(new NetworkError());

        render(<App />);

        expect(await screen.findByRole('alert')).toHaveTextContent(/can't reach the server/i);
        expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });

    it('refetches when Refresh is pressed', async () => {
        const user = userEvent.setup();
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 1, name: 'Trash' })]);

        render(<App />);
        await screen.findByText('Trash');

        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 2, name: 'Recycling' })]);
        await user.click(screen.getByRole('button', { name: /refresh/i }));

        expect(await screen.findByText('Recycling')).toBeInTheDocument();
        expect(screen.queryByText('Trash')).not.toBeInTheDocument();
    });

    it('confirms an empty list rather than showing a blank screen', async () => {
        vi.mocked(api.getChores).mockResolvedValue([]);

        render(<App />);

        expect(await screen.findByText(/nothing due/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
        // The board covers a day ahead now, so it is no longer titled Overdue.
        expect(screen.getByRole('heading')).toHaveTextContent(/^tasks$/i);
    });

    // The three tests below all guard the same rule: never state something
    // the app has not confirmed. An empty list during a load is not the same
    // fact as "nothing is due".
    it('shows a loading state on first load, not an empty list', async () => {
        vi.mocked(api.getChores).mockReturnValue(new Promise(() => {}));

        render(<App />);

        expect(await screen.findByText(/loading/i)).toBeInTheDocument();
        expect(screen.queryByText(/nothing due/i)).not.toBeInTheDocument();
    });

    it('does not un-strike a completed row while refreshing', async () => {
        const user = userEvent.setup();
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 42, name: 'Trash' })]);

        render(<App />);
        const item = await screen.findByRole('listitem');
        await user.click(within(item).getByRole('button', { name: /done/i }));
        await waitFor(() => expect(item).toHaveAttribute('data-status', 'done'));

        vi.mocked(api.getChores).mockReturnValue(new Promise(() => {}));
        await user.click(screen.getByRole('button', { name: /refresh/i }));

        // The stale row must not reappear in its pre-completion state.
        expect(await screen.findByText(/loading/i)).toBeInTheDocument();
        expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    });

    it('does not claim the list is empty when the load failed', async () => {
        vi.mocked(api.getChores).mockRejectedValue(new NetworkError());

        render(<App />);

        await screen.findByRole('alert');
        expect(screen.queryByText(/nothing due/i)).not.toBeInTheDocument();
    });

    describe('public filter', () => {
        function mixed() {
            vi.mocked(api.getChores).mockResolvedValue([
                chore({ id: 1, name: 'Trash', isPrivate: false }),
                chore({ id: 2, name: 'Plants', isPrivate: true }),
            ]);
        }

        it('sits to the left of Refresh', async () => {
            render(<App />);
            await screen.findByText(/nothing due/i);

            expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
                'Public',
                'Refresh',
            ]);
        });

        it('hides private chores once it is on', async () => {
            const user = userEvent.setup();
            mixed();

            render(<App />);
            await screen.findByText('Plants');
            await user.click(screen.getByRole('button', { name: /public/i }));

            expect(screen.queryByText('Plants')).not.toBeInTheDocument();
            expect(screen.getByText('Trash')).toBeInTheDocument();
        });

        it('brings the private chores back when it is turned off', async () => {
            const user = userEvent.setup();
            mixed();

            render(<App />);
            await screen.findByText('Plants');
            const filter = screen.getByRole('button', { name: /public/i });
            await user.click(filter);
            await user.click(filter);

            expect(screen.getByText('Plants')).toBeInTheDocument();
        });

        it('reports whether it is on', async () => {
            const user = userEvent.setup();

            render(<App />);
            const filter = await screen.findByRole('button', { name: /public/i });
            expect(filter).toHaveAttribute('aria-pressed', 'false');

            await user.click(filter);
            expect(filter).toHaveAttribute('aria-pressed', 'true');
        });

        it('is still on after a reload', async () => {
            const user = userEvent.setup();
            mixed();

            const first = render(<App />);
            await screen.findByText('Plants');
            await user.click(screen.getByRole('button', { name: /public/i }));
            first.unmount();

            render(<App />);

            expect(await screen.findByText('Trash')).toBeInTheDocument();
            expect(screen.queryByText('Plants')).not.toBeInTheDocument();
            expect(screen.getByRole('button', { name: /public/i })).toHaveAttribute(
                'aria-pressed',
                'true',
            );
        });

        // Same rule as everywhere else on this board: say only what is true.
        // A filtered-out chore is still due.
        it('does not claim nothing is due when the filter is what emptied the list', async () => {
            const user = userEvent.setup();
            vi.mocked(api.getChores).mockResolvedValue([
                chore({ id: 2, name: 'Plants', isPrivate: true }),
            ]);

            render(<App />);
            await screen.findByText('Plants');
            await user.click(screen.getByRole('button', { name: /public/i }));

            expect(screen.getByText(/nothing public due/i)).toBeInTheDocument();
            expect(screen.queryByText(/^nothing due$/i)).not.toBeInTheDocument();
        });

        // A wall tablet in a locked-down kiosk profile can refuse storage
        // outright. Losing the preference across reloads is survivable;
        // taking the board down with it is not.
        it('still toggles when local storage refuses to keep it', async () => {
            const user = userEvent.setup();
            vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
                throw new Error('storage disabled');
            });
            mixed();

            render(<App />);
            await screen.findByText('Plants');
            await user.click(screen.getByRole('button', { name: /public/i }));

            expect(screen.queryByText('Plants')).not.toBeInTheDocument();
        });
    });

    describe('description', () => {
        it('shows a chore description under the row', async () => {
            vi.mocked(api.getChores).mockResolvedValue([
                chore({
                    name: 'Finances',
                    description: '<p>Input numbers</p>',
                }),
            ]);

            render(<App />);

            expect(
                await screen.findByText('Input numbers'),
            ).toBeInTheDocument();
        });

        it('keeps the list structure of a description written as a list', async () => {
            vi.mocked(api.getChores).mockResolvedValue([
                chore({
                    name: 'Finances',
                    description: '<ol><li>Input numbers</li><li>Download statements</li></ol>',
                }),
            ]);

            const { container } = render(<App />);
            await screen.findByText('Input numbers');

            const band = container.querySelector('.row__description') as HTMLElement;
            expect(within(band).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
                'Input numbers',
                'Download statements',
            ]);
        });

        it('leaves the row alone when the chore has no description', async () => {
            vi.mocked(api.getChores).mockResolvedValue([chore({ name: 'Trash', description: '' })]);

            const { container } = render(<App />);
            await screen.findByText('Trash');

            expect(container.querySelector('.row__description')).not.toBeInTheDocument();
        });

        /*
         * The row is the app's only dangerouslySetInnerHTML, so this is the
         * test that says the sanitizer is actually wired to it rather than
         * merely existing and passing its own suite.
         */
        it('never puts a script from a description into the page', async () => {
            vi.mocked(api.getChores).mockResolvedValue([
                chore({
                    name: 'Trash',
                    description: '<p>Bins</p><script>window.pwned = true</script>',
                }),
            ]);

            const { container } = render(<App />);
            await screen.findByText('Bins');

            expect(container.querySelector('script')).not.toBeInTheDocument();
        });
    });
    /*
     * The board is a wall tablet nobody reloads, so everything it says about
     * time — the 24-hour window, "in 3 hours", the tomorrow badge — is frozen
     * at the last fetch. The rollover is what un-freezes it.
     */
    describe('day rollover', () => {
        it('reloads the page when the local date turns over', async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            vi.setSystemTime(new Date('2026-09-05T23:55:00'));

            render(<App />);
            await screen.findByText('Nothing due');

            // Ten minutes from 23:55 lands at 00:05 the next day.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(TICK_MS);
            });

            expect(window.location.reload).toHaveBeenCalledTimes(1);
        });

        it('leaves the page alone while the date holds', async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            vi.setSystemTime(new Date('2026-09-05T09:00:00'));

            render(<App />);
            await screen.findByText('Nothing due');

            await act(async () => {
                await vi.advanceTimersByTimeAsync(TICK_MS * 6);
            });

            expect(window.location.reload).not.toHaveBeenCalled();
        });
    });
});
