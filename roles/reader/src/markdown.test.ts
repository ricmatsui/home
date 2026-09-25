import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdown, normalizeHref } from './markdown.js';

test('an extensionless relative link becomes a root-relative note link', () => {
    assert.deepEqual(normalizeHref('260415-0000a'), {
        href: '/260415-0000a',
        external: false,
    });
});

test('a .md extension is stripped', () => {
    assert.deepEqual(normalizeHref('220306-0621.md'), {
        href: '/220306-0621',
        external: false,
    });
});

test('an anchor on a note link is preserved', () => {
    assert.deepEqual(normalizeHref('220306-0621#weather'), {
        href: '/220306-0621#weather',
        external: false,
    });
});

test('a bare anchor is left alone', () => {
    assert.deepEqual(normalizeHref('#weather'), {
        href: '#weather',
        external: false,
    });
});

test('absolute and scheme-bearing hrefs are left alone and marked external', () => {
    assert.deepEqual(normalizeHref('https://example.com'), {
        href: 'https://example.com',
        external: true,
    });
    assert.deepEqual(normalizeHref('mailto:x@example.com'), {
        href: 'mailto:x@example.com',
        external: true,
    });
    assert.deepEqual(normalizeHref('//example.com/x'), {
        href: '//example.com/x',
        external: true,
    });
});

test('an already root-relative href is left alone and is not external', () => {
    assert.deepEqual(normalizeHref('/index'), {
        href: '/index',
        external: false,
    });
});

test('renders a markdown note link as a root-relative anchor', () => {
    const html = createMarkdown().render('See [another note](220306-0621) today.');

    assert.match(html, /<a href="\/220306-0621">another note<\/a>/);
});

test('renders an external link with target and rel', () => {
    const html = createMarkdown().render('[t](https://example.com)');

    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noreferrer"/);
});

test('linkifies a bare url, since notes contain them unbracketed', () => {
    const html = createMarkdown().render('Follow https://example.com');

    assert.match(html, /<a href="https:\/\/example\.com"/);
});

test('renders a labelled wikilink', () => {
    const html = createMarkdown().render('- [[251129-1242|A label]]');

    assert.match(html, /<a href="\/251129-1242">A label<\/a>/);
});

test('renders an unlabelled wikilink using the target as the label', () => {
    const html = createMarkdown().render('[[251129-1242]]');

    assert.match(html, /<a href="\/251129-1242">251129-1242<\/a>/);
});

test('leaves an unterminated double bracket as literal text', () => {
    const html = createMarkdown().render('[[not closed');

    assert.match(html, /\[\[not closed/);
});

test('does not emit raw html from note content', () => {
    const html = createMarkdown().render('<script>alert(1)</script>');

    assert.equal(html.includes('<script>'), false);
});

test('renders a code fence without a highlighter', () => {
    const html = createMarkdown().render('```\nconst x = 1;\n```');

    assert.match(html, /<pre><code>const x = 1;/);
});

test('demotes body headings one level so the note title is the only h1', () => {
    // The wiki uses '#' for section headings almost exclusively: 988 '#'
    // against 14 '##' across the corpus. Rendered as-is they would collide
    // with the document title.
    const html = createMarkdown().render('# Weather\n\ntext\n');

    assert.match(html, /<h2>Weather<\/h2>/);
    assert.equal(html.includes('<h1>'), false);
});

test('demotes each heading level in turn', () => {
    const html = createMarkdown().render('# a\n\n## b\n\n### c\n');

    assert.match(html, /<h2>a<\/h2>/);
    assert.match(html, /<h3>b<\/h3>/);
    assert.match(html, /<h4>c<\/h4>/);
});

test('clamps demotion at h6 rather than emitting h7', () => {
    const html = createMarkdown().render('###### deep\n');

    assert.match(html, /<h6>deep<\/h6>/);
    assert.equal(html.includes('<h7>'), false);
});

// The blank lines the wiki puts between top-level items are the only record
// of the spacing the author intended, and markdown-it keeps that record: a
// list whose items are separated by blank lines is loose and wraps each item
// in a <p>, a list written without them is tight and does not. The stylesheet
// reads those <p> tags back to restore the gap, so the distinction is a
// contract rather than an implementation detail.
test('wraps items of a blank-line-separated list in paragraphs', () => {
    const html = createMarkdown().render('- first\n\n- second\n');

    assert.match(html, /<li>\s*<p>first<\/p>/);
    assert.match(html, /<li>\s*<p>second<\/p>/);
});

test('leaves items of a list written without blank lines unwrapped', () => {
    const html = createMarkdown().render('- first\n- second\n');

    assert.equal(html.includes('<p>'), false);
});

test('keeps a tight nested list tight inside a loose parent', () => {
    // The wiki's shape: blank lines between the outer items only. The gap
    // belongs between those, not between a parent and its children.
    const html = createMarkdown().render(
        ['- [ ] parent', '    - child', '', '- [ ] sibling'].join('\n'),
    );

    assert.match(html, /<p>parent<\/p>/);
    assert.match(html, /<li>child<\/li>/);
});
