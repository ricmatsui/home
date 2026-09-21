/**
 * Run `worker` over `items`, at most `limit` at a time, and return the results in
 * the order the items came in — a scored run is read image by image, and results
 * that arrived in whatever order the server finished them would make two runs of
 * the same corpus impossible to read side by side.
 *
 * Workers pull from a shared cursor rather than being handed a fixed slice each,
 * so one slow frame does not leave a lane idle while another lane queues.
 */
export async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;

    async function lane(): Promise<void> {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index] as T, index);
        }
    }

    const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane);
    await Promise.all(lanes);

    return results;
}
