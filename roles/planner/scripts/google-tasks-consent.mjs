/*
 * One-off consent for the planner's read-only Google Tasks access. Runs the
 * loopback flow a Desktop OAuth client expects, then prints the refresh token
 * to store as config.planner.google_tasks.refresh_token.
 *
 * Reads GOOGLE_TASKS_CLIENT_ID and GOOGLE_TASKS_CLIENT_SECRET from the role's
 * .env, or from the environment, which wins over the file:
 *
 *   node scripts/google-tasks-consent.mjs
 *
 * Run it again whenever the day file says "Token request failed (400 invalid_grant)".
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const SCOPE = 'https://www.googleapis.com/auth/tasks.readonly';

try {
    process.loadEnvFile(new URL('../.env', import.meta.url));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}

const clientId = process.env.GOOGLE_TASKS_CLIENT_ID;
const clientSecret = process.env.GOOGLE_TASKS_CLIENT_SECRET;
if (!clientId || !clientSecret) {
    console.error('GOOGLE_TASKS_CLIENT_ID and GOOGLE_TASKS_CLIENT_SECRET must be set');
    process.exit(1);
}

const base64url = buffer => buffer.toString('base64url');
const verifier = base64url(crypto.randomBytes(32));
const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
const state = base64url(crypto.randomBytes(16));

const server = http.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}`;

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    // Without both, a second consent answers with no refresh token at all
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
}).toString();

console.error(`Opening the consent page. If it does not open, visit:\n\n${authUrl}\n`);
execFile('open', [authUrl.toString()], () => {});

const code = await new Promise((resolve, reject) => {
    server.on('request', (request, response) => {
        const params = new URL(request.url, redirectUri).searchParams;
        if (!params.has('code') && !params.has('error')) {
            response.writeHead(404).end();
            return;
        }

        response.writeHead(200, { 'content-type': 'text/plain' });

        if (params.get('state') !== state) {
            response.end('State mismatch; close this tab.');
            reject(new Error('State mismatch'));
        } else if (params.has('error')) {
            response.end(`Consent failed: ${params.get('error')}; close this tab.`);
            reject(new Error(`Consent failed: ${params.get('error')}`));
        } else {
            response.end('Consent received; close this tab and return to the terminal.');
            resolve(params.get('code'));
        }
    });
}).finally(() => server.close());

const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
    }),
});

const body = await response.json();
if (!response.ok || !body.refresh_token) {
    console.error('Token exchange did not return a refresh token:', body);
    process.exit(1);
}

console.log(body.refresh_token);
