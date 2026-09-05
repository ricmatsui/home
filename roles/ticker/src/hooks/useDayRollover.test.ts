import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TICK_MS, useDayRollover } from './useDayRollover';

// Tests run under TZ=America/Los_Angeles, so these are local wall-clock times.
function local(iso: string): Date {
    return new Date(iso);
}

// A clock the test moves by hand, so a rollover costs one assignment rather
// than a night of waiting.
function stubClock(start: Date) {
    let current = start;
    return {
        now: () => current,
        set: (next: Date) => {
            current = next;
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('useDayRollover', () => {
    it('does not fire while the local date is unchanged', () => {
        const clock = stubClock(local('2026-09-05T09:00:00'));
        const onRollover = vi.fn();

        renderHook(() => useDayRollover(onRollover, clock.now));

        clock.set(local('2026-09-05T23:59:00'));
        act(() => {
            vi.advanceTimersByTime(TICK_MS * 100);
        });

        expect(onRollover).not.toHaveBeenCalled();
    });

    it('fires once the local date turns over', () => {
        const clock = stubClock(local('2026-09-05T23:55:00'));
        const onRollover = vi.fn();

        renderHook(() => useDayRollover(onRollover, clock.now));

        clock.set(local('2026-09-06T00:01:00'));
        act(() => {
            vi.advanceTimersByTime(TICK_MS);
        });

        expect(onRollover).toHaveBeenCalledTimes(1);
    });

    it('fires only once when later ticks see the same new date', () => {
        const clock = stubClock(local('2026-09-05T23:55:00'));
        const onRollover = vi.fn();

        renderHook(() => useDayRollover(onRollover, clock.now));

        clock.set(local('2026-09-06T00:01:00'));
        act(() => {
            vi.advanceTimersByTime(TICK_MS * 10);
        });

        expect(onRollover).toHaveBeenCalledTimes(1);
    });

    /*
     * The tablet sleeps. Whatever a timer scheduled for midnight would have
     * done, the first tick after waking still sees a date that is not the one
     * the board was rendered against.
     */
    it('fires on the first tick after a sleep that skipped past midnight', () => {
        const clock = stubClock(local('2026-09-05T22:00:00'));
        const onRollover = vi.fn();

        renderHook(() => useDayRollover(onRollover, clock.now));

        clock.set(local('2026-09-06T07:30:00'));
        act(() => {
            vi.advanceTimersByTime(TICK_MS);
        });

        expect(onRollover).toHaveBeenCalledTimes(1);
    });

    // 2026-11-01 is the US fall-back date: that local day is 25 hours long and
    // 01:30 happens twice. Neither repeat is a new date.
    it('does not fire on the repeated hour of a DST fall-back night', () => {
        const clock = stubClock(local('2026-11-01T00:30:00'));
        const onRollover = vi.fn();

        renderHook(() => useDayRollover(onRollover, clock.now));

        clock.set(new Date('2026-11-01T08:30:00Z')); // 01:30 PDT
        act(() => {
            vi.advanceTimersByTime(TICK_MS);
        });
        clock.set(new Date('2026-11-01T09:30:00Z')); // 01:30 PST, an hour later
        act(() => {
            vi.advanceTimersByTime(TICK_MS);
        });

        expect(onRollover).not.toHaveBeenCalled();
    });

    it('stops ticking once unmounted', () => {
        const clock = stubClock(local('2026-09-05T23:55:00'));
        const onRollover = vi.fn();

        const { unmount } = renderHook(() => useDayRollover(onRollover, clock.now));
        unmount();

        clock.set(local('2026-09-06T00:01:00'));
        act(() => {
            vi.advanceTimersByTime(TICK_MS * 10);
        });

        expect(onRollover).not.toHaveBeenCalled();
    });
});
