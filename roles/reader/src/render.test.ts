import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNote, renderNotFound } from './render.js';

const NOTE = [
    '---',
    'title: 2026-09-18',
    'tags: :zettel:',
    'date: 2026-07-26 00:00',
    'parent: [Parent note](220306-0621)',
    '---',
    '',
    '# Section',
    '',
    '- [X] Follow https://example.com',
    '- [.] A parent item',
    '    - [ ] A nested item',
    '',
].join('\n');

test('produces a complete html document', () => {
    const html = renderNote(NOTE, '260726-0000a');

    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<\/html>\s*$/);
});

test('uses the frontmatter title for the document title and heading', () => {
    const html = renderNote(NOTE, '260726-0000a');

    assert.match(html, /<title>2026-09-18<\/title>/);
    assert.match(html, /<h1>2026-09-18<\/h1>/);
});

test('falls back to the id when the note has no title', () => {
    const html = renderNote('just body text\n', '221126-1938');

    assert.match(html, /<title>221126-1938<\/title>/);
    assert.match(html, /<h1>221126-1938<\/h1>/);
});

test('renders the parent frontmatter as a working breadcrumb link', () => {
    const html = renderNote(NOTE, '260726-0000a');

    assert.match(html, /<a href="\/220306-0621">Parent note<\/a>/);
});

test('shows the tags', () => {
    const html = renderNote(NOTE, '260726-0000a');

    assert.match(html, /:zettel:/);
});

test('inlines the stylesheet rather than linking an asset', () => {
    const html = renderNote(NOTE, '260726-0000a');

    assert.match(html, /<style>/);
    assert.equal(html.includes('<link rel="stylesheet"'), false);
});

test('offsets checkbox line numbers past the frontmatter', () => {
    const html = renderNote(NOTE, '260726-0000a');

    // The '- [X] Follow ...' line is line 9 of the source file.
    assert.equal(NOTE.split('\n')[9].startsWith('- [X] Follow'), true);
    assert.match(html, /data-line="9"/);
});

test('escapes a title that contains html-significant characters', () => {
    const html = renderNote('---\ntitle: a < b & c\n---\nbody\n', 'x');

    assert.match(html, /<title>a &lt; b &amp; c<\/title>/);
    assert.equal(html.includes('<title>a < b'), false);
});

test('the not found page is a complete document naming the id', () => {
    const html = renderNotFound('nope');

    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /nope/);
    assert.match(html, /<a href="\/">/);
});

test('escapes the id on the not found page', () => {
    const html = renderNotFound('<script>x</script>');

    assert.equal(html.includes('<script>x</script>'), false);
    assert.match(html, /&lt;script&gt;/);
});
