/*
 * The manifest and its icons are static files, not code, so nothing else in
 * the suite would notice if one went missing or stopped matching the other.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path));
const text = (path: string) => read(path).toString('utf8');

/*
 * PNG stores width and height as big-endian uint32 at a fixed offset inside
 * the IHDR chunk, which is always first. Cheaper than taking on an image
 * dependency for four files.
 */
function pngSize(path: string): { width: number; height: number } {
    const buffer = read(path);
    const signature = buffer.subarray(0, 8).toString('hex');
    if (signature !== '89504e470d0a1a0a') {
        throw new Error(`${path} is not a PNG`);
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const manifest = JSON.parse(text('public/manifest.json'));

describe('web app manifest', () => {
    it('declares the fields a browser needs to offer installation', () => {
        expect(manifest.name).toBe('Ticker');
        expect(manifest.short_name).toBe('Ticker');
        expect(manifest.start_url).toBe('/');
        expect(manifest.display).toBe('standalone');
    });

    /*
     * Both are the board black. background_color paints the launch screen
     * before the first frame, so a mismatch shows up as a flash.
     */
    it('paints the launch screen in the board colours', () => {
        expect(manifest.background_color).toBe('#0c0d0f');
        expect(manifest.theme_color).toBe('#0c0d0f');
    });

    it('ships every icon it references, at the size it claims', () => {
        const pngs = manifest.icons.filter(
            (icon: { type: string }) => icon.type === 'image/png',
        );
        expect(pngs.length).toBeGreaterThan(0);

        for (const icon of pngs) {
            const [width, height] = icon.sizes.split('x').map(Number);
            expect(pngSize(`public${icon.src}`)).toEqual({ width, height });
        }
    });

    /*
     * Android crops adaptive icons to an arbitrary shape inside a circle of
     * 80% of the canvas. Without a maskable icon it pillarboxes the "any" one
     * onto a white square instead, which is both ugly and the wrong colour.
     */
    it('offers a maskable icon for Android adaptive shapes', () => {
        const maskable = manifest.icons.filter((icon: { purpose?: string }) =>
            icon.purpose?.split(' ').includes('maskable'),
        );
        expect(maskable).toHaveLength(1);
    });

    it('is linked from the document, with the icons Safari looks for', () => {
        const html = text('index.html');
        expect(html).toContain('rel="manifest" href="/manifest.json"');
        expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
        expect(pngSize('public/apple-touch-icon.png')).toEqual({ width: 180, height: 180 });
    });

    /*
     * Two media-scoped tags rather than one flat colour: the app follows
     * prefers-color-scheme, so a single value would leave the browser chrome
     * fighting the page half the time.
     */
    it('gives the browser chrome a colour for each scheme', () => {
        const html = text('index.html');
        expect(html).toContain('media="(prefers-color-scheme: light)" content="#f4efe4"');
        expect(html).toContain('media="(prefers-color-scheme: dark)" content="#0c0d0f"');
    });
});
