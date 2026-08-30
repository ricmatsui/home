/*
 * Serialises async work: one task in flight, the rest waiting their turn in
 * the order they were handed over. Callers see an ordinary promise and cannot
 * tell whether their task ran straight away or waited.
 */
export function createQueue() {
    let tail: Promise<unknown> = Promise.resolve();

    return function run<T>(task: () => Promise<T>): Promise<T> {
        // Both arms are the same task: a failure ahead in the queue is not a
        // reason to strand everything behind it. The caller still gets the
        // rejection, because that is `result`, not `tail`.
        const result = tail.then(task, task);
        tail = result.catch(() => {});
        return result;
    };
}
