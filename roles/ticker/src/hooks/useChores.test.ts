import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChores } from './useChores';
import * as api from '../api/donetick';
import { ApiError, SessionExpiredError } from '../lib/errors';
import type { Chore } from '../types';

const NOW = new Date('2026-08-15T12:00:00Z');
const clock = () => NOW;

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
    vi.spyOn(api, 'getChores').mockResolvedValue([]);
    vi.spyOn(api, 'completeChore').mockResolvedValue(undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('useChores', () => {
    it('loads due chores on mount, filtered and sorted', async () => {
        vi.mocked(api.getChores).mockResolvedValue([
            chore({ id: 1, priority: 0 }),
            chore({ id: 2, priority: 1 }),
            chore({ id: 3, nextDueDate: '2026-09-01T12:00:00Z' }),
        ]);

        const { result } = renderHook(() => useChores(clock));

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.chores.map((c) => c.id)).toEqual([2, 1]);
    });

    it('marks a row done after the API succeeds', async () => {
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 5 })]);

        const { result } = renderHook(() => useChores(clock));
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(async () => {
            await result.current.complete(5);
        });

        expect(result.current.rowStatus[5]).toBe('done');
        expect(api.completeChore).toHaveBeenCalledWith(5);
    });

    it('keeps the completed chore in the list', async () => {
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 5 })]);

        const { result } = renderHook(() => useChores(clock));
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(async () => {
            await result.current.complete(5);
        });

        expect(result.current.chores.map((c) => c.id)).toEqual([5]);
    });

    it('records a per-row error without setting the global error', async () => {
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 5 })]);
        vi.mocked(api.completeChore).mockRejectedValue(
            new ApiError(400, 'Chore is out of completion window'),
        );

        const { result } = renderHook(() => useChores(clock));
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(async () => {
            await result.current.complete(5);
        });

        expect(result.current.rowStatus[5]).toBe('error');
        expect(result.current.rowError[5]).toBe('Chore is out of completion window');
        expect(result.current.error).toBeNull();
    });

    it('promotes a session expiry during completion to the global error', async () => {
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 5 })]);
        vi.mocked(api.completeChore).mockRejectedValue(new SessionExpiredError());

        const { result } = renderHook(() => useChores(clock));
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(async () => {
            await result.current.complete(5);
        });

        expect(result.current.error).toBeInstanceOf(SessionExpiredError);
    });

    it('sets the global error when the initial load fails', async () => {
        vi.mocked(api.getChores).mockRejectedValue(new SessionExpiredError());

        const { result } = renderHook(() => useChores(clock));

        await waitFor(() => expect(result.current.error).toBeInstanceOf(SessionExpiredError));
        expect(result.current.loading).toBe(false);
    });

    it('refresh refetches and clears completed row state', async () => {
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 5 })]);

        const { result } = renderHook(() => useChores(clock));
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(async () => {
            await result.current.complete(5);
        });
        expect(result.current.rowStatus[5]).toBe('done');

        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 9 })]);
        await act(async () => {
            await result.current.refresh();
        });

        expect(result.current.rowStatus).toEqual({});
        expect(result.current.chores.map((c) => c.id)).toEqual([9]);
    });

    it('keeps completed row state until the refresh actually returns', async () => {
        vi.mocked(api.getChores).mockResolvedValue([chore({ id: 5 })]);

        const { result } = renderHook(() => useChores(clock));
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(async () => {
            await result.current.complete(5);
        });

        vi.mocked(api.getChores).mockReturnValue(new Promise(() => {}));
        act(() => {
            void result.current.refresh();
        });

        // Clearing row state up front un-strikes the row against stale chores.
        await waitFor(() => expect(result.current.loading).toBe(true));
        expect(result.current.rowStatus[5]).toBe('done');
    });

    it('does not fetch on its own after mounting', async () => {
        const { result } = renderHook(() => useChores(clock));
        await waitFor(() => expect(result.current.loading).toBe(false));

        const callsAfterMount = vi.mocked(api.getChores).mock.calls.length;
        window.dispatchEvent(new Event('focus'));
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(vi.mocked(api.getChores).mock.calls.length).toBe(callsAfterMount);
    });
});
