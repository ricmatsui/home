import { describe, expect, it } from 'vitest';
import { parseUsers } from './users';

describe('parseUsers', () => {
    it('reads a JSON array of people in the order they were written', () => {
        expect(
            parseUsers('[{"name":"Jane","id":1},{"name":"John","id":2}]'),
        ).toEqual([
            { name: 'Jane', id: 1 },
            { name: 'John', id: 2 },
        ]);
    });

    it('has no people when the variable is unset', () => {
        expect(parseUsers('')).toEqual([]);
    });

    // A roster that cannot be read is a deployment mistake, and the board
    // falling back to its old single Done button is a far better outcome than
    // a blank screen — so nothing in here is allowed to throw.
    it('has no people rather than throwing when the JSON is malformed', () => {
        expect(parseUsers('[{"name":"Jane",')).toEqual([]);
    });

    it('has no people when the JSON is not an array', () => {
        expect(parseUsers('{"name":"Jane","id":1}')).toEqual([]);
    });

    /*
     * Donetick's /circles/members returns both a membership `id` and a
     * `userId`, and completedBy wants the second one. They happen to be equal
     * for the first member of a circle and differ for everyone added later,
     * so a wrong reading works for one person and silently miscredits the
     * rest. Dropping unusable entries keeps that mistake loud.
     */
    it('drops a person with no usable id', () => {
        expect(
            parseUsers('[{"name":"Jane","id":1},{"name":"John"},{"name":"Sam","id":"2"}]'),
        ).toEqual([{ name: 'Jane', id: 1 }]);
    });

    it('drops a person with no name', () => {
        expect(parseUsers('[{"name":"","id":1},{"id":2}]')).toEqual([]);
    });
});
