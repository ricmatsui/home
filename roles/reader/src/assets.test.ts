import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSETS } from './assets.js';

interface ManifestIcon {
    src: string;
    sizes: string;
    type: string;
    purpose: string;
}

interface Manifest {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    background_color: string;
    theme_color: string;
    icons: ManifestIcon[];
}

function body(route: string): Buffer {
    const asset = ASSETS.get(route);
    assert.notEqual(asset, undefined, `nothing is served at ${route}`);
    return asset!.body;
}

function manifest(): Manifest {
    return JSON.parse(body('/manifest.webmanifest').toString('utf8')) as Manifest;
}

// Width and height live in the IHDR chunk, at a fixed offset in every png.
function pngSize(png: Buffer): { width: number; height: number } {
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test('the manifest describes a standalone app in the note colours', () => {
    const parsed = manifest();

    assert.equal(parsed.name, 'Reader');
    assert.equal(parsed.short_name, 'Reader');
    assert.equal(parsed.start_url, '/');
    assert.equal(parsed.scope, '/');
    assert.equal(parsed.display, 'standalone');
    assert.equal(parsed.background_color, '#151515');
    assert.equal(parsed.theme_color, '#151515');
});

test('every icon the manifest advertises is actually served', () => {
    for (const icon of manifest().icons) {
        assert.equal(
            ASSETS.has(icon.src),
            true,
            `manifest names ${icon.src} but no asset serves it`,
        );
    }
});

test('the manifest offers a maskable icon so android does not crop onto white', () => {
    const purposes = manifest().icons.map(icon => icon.purpose);

    assert.equal(purposes.includes('maskable'), true);
    assert.equal(purposes.includes('any'), true);
});

test('each png is a real png of the size the manifest claims', () => {
    for (const icon of manifest().icons) {
        if (icon.type !== 'image/png') {
            continue;
        }

        const png = body(icon.src);
        assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');

        const expected = Number(icon.sizes.split('x')[0]);
        assert.deepEqual(pngSize(png), { width: expected, height: expected });
    }
});

test('the svg icon scales to any size', () => {
    const svg = manifest().icons.find(icon => icon.type === 'image/svg+xml');
    assert.notEqual(svg, undefined);

    assert.equal(svg!.sizes, 'any');
    assert.match(body(svg!.src).toString('utf8'), /^<svg/);
});

test('every asset carries a strong etag and a content type', () => {
    for (const [route, asset] of ASSETS) {
        assert.match(asset.etag, /^"[0-9a-f]{16}"$/, `${route} has no strong etag`);
        assert.notEqual(asset.contentType, '');
    }
});

test('no two assets share an etag, so one cannot be served for another', () => {
    const etags = [...ASSETS.values()].map(asset => asset.etag);

    assert.equal(new Set(etags).size, etags.length);
});
