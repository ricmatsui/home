import http from 'node:http';
import fs from 'node:fs/promises';
import { resolveNotePath } from './ids.js';
import { renderNote, renderNotFound } from './render.js';
import { RenderCache, computeEtag, type CacheEntry } from './cache.js';

export interface ServerOptions {
    wikiPath: string;
    cache?: RenderCache;
}

function etagMatches(header: string | undefined, etag: string): boolean {
    if (header === undefined) {
        return false;
    }

    return header
        .split(',')
        .map(candidate => candidate.trim())
        .map(candidate => (candidate.startsWith('W/') ? candidate.slice(2) : candidate))
        .some(candidate => candidate === etag || candidate === '*');
}

export function createServer(options: ServerOptions): http.Server {
    const cache = options.cache ?? new RenderCache();

    function notFound(response: http.ServerResponse, id: string): void {
        const html = renderNotFound(id);
        response.writeHead(404, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
            'content-length': Buffer.byteLength(html),
        });
        response.end(html);
    }

    async function handle(
        request: http.IncomingMessage,
        response: http.ServerResponse,
    ): Promise<void> {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET, HEAD' });
            response.end();
            return;
        }

        const url = new URL(request.url ?? '/', 'http://localhost');
        const pathname = decodeURIComponent(url.pathname);
        const id = pathname === '/' ? 'index' : pathname.slice(1);

        const file = resolveNotePath(options.wikiPath, id);
        if (file === null) {
            notFound(response, id);
            return;
        }

        let stats;
        try {
            stats = await fs.stat(file);
        } catch {
            notFound(response, id);
            return;
        }

        if (!stats.isFile()) {
            notFound(response, id);
            return;
        }

        let entry = cache.get(file, stats.mtimeMs, stats.size);

        if (entry === undefined) {
            const source = await fs.readFile(file, 'utf8');
            const html = renderNote(source, id);
            entry = {
                mtimeMs: stats.mtimeMs,
                size: stats.size,
                etag: computeEtag(html),
                html,
            } satisfies CacheEntry;
            cache.set(file, entry);
        }

        const headers: http.OutgoingHttpHeaders = {
            // Store it, but revalidate every time: an unchanged note costs a
            // stat and a 304, a changed note is visible on the next load.
            'cache-control': 'no-cache',
            etag: entry.etag,
            'last-modified': new Date(stats.mtimeMs).toUTCString(),
        };

        if (etagMatches(request.headers['if-none-match'], entry.etag)) {
            response.writeHead(304, headers);
            response.end();
            return;
        }

        response.writeHead(200, {
            ...headers,
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(entry.html),
        });

        if (request.method === 'HEAD') {
            response.end();
            return;
        }

        response.end(entry.html);
    }

    return http.createServer((request, response) => {
        void handle(request, response).catch(() => {
            if (!response.headersSent) {
                response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            }
            response.end('Internal error');
        });
    });
}
