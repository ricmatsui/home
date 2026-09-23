import { createHash } from 'node:crypto';

export interface CacheEntry {
    mtimeMs: number;
    size: number;
    etag: string;
    html: string;
}

export function computeEtag(content: string | Buffer): string {
    return `"${createHash('sha256').update(content).digest('hex').slice(0, 16)}"`;
}

const DEFAULT_MAX = 100;

export class RenderCache {
    private readonly entries = new Map<string, CacheEntry>();

    constructor(private readonly max: number = DEFAULT_MAX) {}

    get size(): number {
        return this.entries.size;
    }

    // Returns undefined when absent or stale, so callers never compare
    // freshness themselves.
    get(key: string, mtimeMs: number, size: number): CacheEntry | undefined {
        const entry = this.entries.get(key);

        if (entry === undefined) {
            return undefined;
        }
        if (entry.mtimeMs !== mtimeMs || entry.size !== size) {
            return undefined;
        }

        return entry;
    }

    set(key: string, entry: CacheEntry): void {
        this.entries.delete(key);
        this.entries.set(key, entry);

        while (this.entries.size > this.max) {
            const oldest = this.entries.keys().next();
            if (oldest.done === true) {
                break;
            }
            this.entries.delete(oldest.value);
        }
    }
}
