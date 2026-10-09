import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Box } from '../vision.js';
import { applyBoxes, imagesDir, loadLabels, writeLabels } from './corpus.js';
import { renderAnnotator } from './report.js';

/** Far above any real save (a few hundred boxes), far below anything that could hurt. */
const MAX_BODY_BYTES = 1_000_000;

const CONTENT_TYPES: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
};

class BadRequest extends Error {}

function send(response: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(body);
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
    send(response, status, 'application/json', JSON.stringify(body));
}

async function readBody(request: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new BadRequest('request body too large');
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

/**
 * The annotator's server, for `yarn eval annotate`. A static page cannot write
 * labels.json, so this serves the page and the frames and takes the save. Images
 * are served only by exact key from the selection: the URL is never joined onto
 * a path, so nothing else on the mount is reachable through it.
 */
export function createAnnotatorServer(options: { corpusDir: string; keys: string[] }): http.Server {
    const selected = new Set(options.keys);

    async function save(request: http.IncomingMessage): Promise<number> {
        let payload: unknown;
        try {
            payload = JSON.parse(await readBody(request));
        } catch (error) {
            throw error instanceof BadRequest ? error : new BadRequest('request body is not JSON');
        }

        const boxes = (payload as { boxes?: unknown } | null)?.boxes;
        if (typeof boxes !== 'object' || boxes === null || Array.isArray(boxes)) {
            throw new BadRequest('expected { "boxes": { "<key>": box | null } }');
        }

        const outside = Object.keys(boxes).filter((key) => !selected.has(key));
        if (outside.length > 0) throw new BadRequest(`not in this session: ${outside.join(', ')}`);

        // Re-read on every save rather than holding the labels from startup, so an
        // edit made to the file while the page was open is merged into, not lost.
        let labels;
        try {
            labels = applyBoxes(await loadLabels(options.corpusDir), boxes as Record<string, Box | null>);
        } catch (error) {
            throw new BadRequest(error instanceof Error ? error.message : String(error));
        }
        await writeLabels(options.corpusDir, labels);

        return Object.keys(boxes).length;
    }

    async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        const url = new URL(request.url ?? '/', 'http://localhost');

        if (request.method === 'GET' && url.pathname === '/') {
            // Rendered per request, so a reload after a save shows what was saved.
            send(response, 200, 'text/html; charset=utf-8', renderAnnotator(await loadLabels(options.corpusDir), options.keys));
            return;
        }

        if (request.method === 'GET' && url.pathname.startsWith('/images/')) {
            let key: string;
            try {
                key = url.pathname.slice('/images/'.length).split('/').map(decodeURIComponent).join('/');
            } catch {
                key = '';
            }
            if (!selected.has(key)) {
                send(response, 404, 'text/plain', 'not found');
                return;
            }
            const type = CONTENT_TYPES[path.extname(key).toLowerCase()] ?? 'application/octet-stream';
            send(response, 200, type, await fs.promises.readFile(path.join(imagesDir(options.corpusDir), key)));
            return;
        }

        if (request.method === 'POST' && url.pathname === '/labels') {
            const saved = await save(request);
            console.log(`saved ${saved} frames to labels.json`);
            sendJson(response, 200, { saved });
            return;
        }

        send(response, 404, 'text/plain', 'not found');
    }

    return http.createServer((request, response) => {
        handle(request, response).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof BadRequest) {
                sendJson(response, 400, { error: message });
                return;
            }
            console.error(`annotate: ${request.method} ${request.url} failed: ${message}`);
            if (!response.headersSent) sendJson(response, 500, { error: message });
            else response.end();
        });
    });
}
