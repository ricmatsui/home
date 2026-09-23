import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from './frontmatter.js';

const NOTE = [
    '---',
    'title: 2026-09-18',
    'tags: :zettel:',
    'date: 2026-07-26 00:00',
    'parent: [Parent note](220306-0621)',
    'previous: [2026-09-17](260917-0910a)',
    'next: [2026-09-19](260919-0910a)',
    '---',
    '',
    '# Section',
    '',
    '- a plain item',
    '',
].join('\n');

test('parses the frontmatter fields of a note', () => {
    const parsed = parseFrontmatter(NOTE);

    assert.equal(parsed.frontmatter.title, '2026-09-18');
    assert.equal(parsed.frontmatter.tags, ':zettel:');
    assert.equal(parsed.frontmatter.date, '2026-07-26 00:00');
});

test('parses the chain fields a day file carries', () => {
    const parsed = parseFrontmatter(NOTE);

    assert.equal(parsed.frontmatter.previous, '[2026-09-17](260917-0910a)');
    assert.equal(parsed.frontmatter.next, '[2026-09-19](260919-0910a)');
});

test('keeps a markdown link in a value intact', () => {
    const parsed = parseFrontmatter(NOTE);

    assert.equal(parsed.frontmatter.parent, '[Parent note](220306-0621)');
});

test('body excludes the frontmatter block', () => {
    const parsed = parseFrontmatter(NOTE);

    assert.equal(parsed.body.startsWith('\n# Section'), true);
    assert.equal(parsed.body.includes('title:'), false);
});

test('bodyOffset counts the lines the frontmatter consumed', () => {
    const parsed = parseFrontmatter(NOTE);

    // Lines 0-7 are the block including both --- delimiters, so the body
    // starts at source line 8.
    assert.equal(parsed.bodyOffset, 8);
    assert.equal(NOTE.split('\n')[parsed.bodyOffset + 1], '# Section');
});

test('a note with no frontmatter is all body at offset zero', () => {
    const parsed = parseFrontmatter('# Just a heading\n\ntext\n');

    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.body, '# Just a heading\n\ntext\n');
    assert.equal(parsed.bodyOffset, 0);
});

test('an unterminated frontmatter block is treated as body, not swallowed', () => {
    const source = '---\ntitle: broken\n\n# Heading\n';
    const parsed = parseFrontmatter(source);

    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.body, source);
    assert.equal(parsed.bodyOffset, 0);
});

test('ignores lines inside the block that are not key: value', () => {
    const parsed = parseFrontmatter('---\ntitle: X\nnot a pair\n---\nbody\n');

    assert.deepEqual(parsed.frontmatter, { title: 'X' });
});

test('handles CRLF line endings', () => {
    const parsed = parseFrontmatter('---\r\ntitle: X\r\n---\r\nbody\r\n');

    assert.equal(parsed.frontmatter.title, 'X');
    assert.equal(parsed.bodyOffset, 3);
});

test('an empty value yields an empty string, not undefined', () => {
    const parsed = parseFrontmatter('---\ntitle:\n---\nbody\n');

    assert.equal(parsed.frontmatter.title, '');
});
