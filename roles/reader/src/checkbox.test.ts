import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdown } from './markdown.js';

test('renders each of the four checkbox states with its own class', () => {
    const html = createMarkdown().render(
        [
            '- [ ] open item',
            '- [X] done item',
            '- [-] dropped item',
            '- [.] in progress item',
        ].join('\n'),
    );

    assert.match(html, /<li class="cb-item cb-open"[^>]*>/);
    assert.match(html, /<li class="cb-item cb-done"[^>]*>/);
    assert.match(html, /<li class="cb-item cb-dropped"[^>]*>/);
    assert.match(html, /<li class="cb-item cb-progress"[^>]*>/);
});

test('accepts a lowercase x as done', () => {
    const html = createMarkdown().render('- [x] done item');

    assert.match(html, /cb-done/);
});

test('strips the marker from the rendered text', () => {
    const html = createMarkdown().render('- [X] done item');

    assert.equal(html.includes('[X]'), false);
    assert.match(html, /done item/);
});

test('emits an empty span for the box, which css draws', () => {
    const html = createMarkdown().render('- [X] done item');

    assert.match(html, /<span class="cb cb-mark-done" aria-hidden="true"><\/span>/);
});

test('records the zero-based source line of each item', () => {
    const html = createMarkdown().render(
        ['- [ ] first', '- [ ] second', '- [ ] third'].join('\n'),
    );

    assert.match(html, /data-line="0"/);
    assert.match(html, /data-line="1"/);
    assert.match(html, /data-line="2"/);
});

test('offsets source lines by the frontmatter length', () => {
    const html = createMarkdown(6).render('- [ ] first\n- [ ] second');

    assert.match(html, /data-line="6"/);
    assert.match(html, /data-line="7"/);
});

test('parses four levels of four-space indentation as nested lists', () => {
    const html = createMarkdown().render(
        [
            '- [.] level one',
            '    - [X] level two',
            '        - [X] level three',
            '            - [X] level four',
        ].join('\n'),
    );

    // Four <ul> means the deepest item really is a list item and not an
    // indented code block.
    assert.equal(html.split('<ul>').length - 1, 4);
    assert.equal(html.includes('<pre>'), false);
    assert.match(html, /level four/);
});

test('leaves a bracket expression in prose alone', () => {
    const html = createMarkdown().render('The flag [x] is set in the config.');

    assert.equal(html.includes('cb-item'), false);
    assert.match(html, /\[x\] is set/);
});

test('leaves an unknown marker alone', () => {
    const html = createMarkdown().render('- [?] not a state');

    assert.equal(html.includes('cb-item'), false);
    assert.match(html, /\[\?\] not a state/);
});

test('leaves a plain list item alone', () => {
    const html = createMarkdown().render('- a plain item');

    assert.equal(html.includes('cb-item'), false);
});

test('keeps links inside a checkbox item working', () => {
    const html = createMarkdown().render('- [ ] [2027-01-05](260415-0000a)');

    assert.match(html, /cb-open/);
    assert.match(html, /<a href="\/260415-0000a">2027-01-05<\/a>/);
});
