import { computeEtag } from './cache.js';
import { ICON_SVG, ICON_PNG_192, ICON_PNG_512 } from './icon.js';
import { BACKGROUND } from './styles.js';

export interface Asset {
    body: Buffer;
    contentType: string;
    etag: string;
}

// The 512 is listed twice on purpose. A maskable icon is cropped to the
// launcher's shape, and an icon offered only as maskable is padded again
// when something wants a plain one; declaring both lets each consumer pick.
const ICONS = [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

const MANIFEST = {
    name: 'Reader',
    short_name: 'Reader',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    icons: ICONS,
};

function asset(body: Buffer, contentType: string): Asset {
    return { body, contentType, etag: computeEtag(body) };
}

// Built once at import: every body is a constant, so there is nothing to
// invalidate and no reason to hash on each request.
export const ASSETS: ReadonlyMap<string, Asset> = new Map([
    [
        '/manifest.webmanifest',
        asset(Buffer.from(JSON.stringify(MANIFEST, null, 4)), 'application/manifest+json'),
    ],
    ['/icon.svg', asset(Buffer.from(ICON_SVG), 'image/svg+xml')],
    ['/icon-192.png', asset(Buffer.from(ICON_PNG_192, 'base64'), 'image/png')],
    ['/icon-512.png', asset(Buffer.from(ICON_PNG_512, 'base64'), 'image/png')],
]);
