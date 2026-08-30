import { describe, expect, it } from 'vitest';

describe('test harness', () => {
    it('runs with a jsdom environment', () => {
        expect(typeof document).toBe('object');
        expect(document.createElement('div')).toBeInstanceOf(HTMLElement);
    });
});
