import http from 'node:http';
import { createLogger } from './log.js';

const log = createLogger('server');

/**
 * Answers 200 as soon as the body has arrived, before anything is done with it: the
 * device holds itself awake until it hears back. That includes a body that is not
 * JSON, since the Enviro firmware keeps and retries anything it sees fail, and a
 * bad payload would be retried forever.
 */
export function createSubmitServer(options: { onBody: (body: unknown) => void | Promise<void> }): http.Server {
    return http.createServer((request, response) => {
        if (request.method !== 'POST' || request.url !== '/submit') {
            response.writeHead(404).end();
            return;
        }

        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            response.writeHead(200).end();

            const text = Buffer.concat(chunks).toString('utf-8');
            let body: unknown;
            try {
                body = JSON.parse(text);
            } catch {
                log.warn('body is not JSON', { body: text });
                return;
            }
            void options.onBody(body);
        });
    });
}
