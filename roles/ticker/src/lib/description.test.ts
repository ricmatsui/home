import { describe, expect, it } from 'vitest';
import { sanitizeDescription } from './description';

describe('sanitizeDescription', () => {
    it('returns nothing for a chore with no description', () => {
        expect(sanitizeDescription('')).toBe('');
    });

    it('keeps a paragraph', () => {
        expect(sanitizeDescription('<p>Input numbers</p>')).toBe(
            '<p>Input numbers</p>',
        );
    });

    it('keeps a list and its items', () => {
        const html = '<ol><li>Input numbers</li><li>Download statements</li></ol>';
        expect(sanitizeDescription(html)).toBe(html);
    });

    it('keeps a table', () => {
        const html = '<table><tbody><tr><td>Input numbers</td></tr></tbody></table>';
        expect(sanitizeDescription(html)).toBe(html);
    });

    it('drops the editor attributes Quill leaves behind', () => {
        const html = '<p class="ql-align-center" data-foo="1">Input numbers</p>';
        expect(sanitizeDescription(html)).toBe('<p>Input numbers</p>');
    });

    /*
     * Quill writes a bulleted list as an <ol> whose items carry
     * data-list="bullet" — the markers come from its own stylesheet, which the
     * board does not load. Strip that attribute and keep the <ol> and a list
     * the author wrote as bullets renders as 1. 2. 3.
     */
    it('renders a Quill bullet list with bullets, not numbers', () => {
        const html =
            '<ol><li data-list="bullet"><span class="ql-ui"></span>Input numbers</li>' +
            '<li data-list="bullet"><span class="ql-ui"></span>Download statements</li></ol>';
        expect(sanitizeDescription(html)).toBe(
            '<ul><li>Input numbers</li><li>Download statements</li></ul>',
        );
    });

    it('leaves a genuinely ordered list numbered', () => {
        const html = '<ol><li data-list="ordered">First</li><li data-list="ordered">Second</li></ol>';
        expect(sanitizeDescription(html)).toBe('<ol><li>First</li><li>Second</li></ol>');
    });

    it('removes a script element and its contents', () => {
        const html = '<p>Salt</p><script>alert(1)</script>';
        expect(sanitizeDescription(html)).toBe('<p>Salt</p>');
    });

    it('removes an inline event handler', () => {
        expect(sanitizeDescription('<p onclick="alert(1)">Salt</p>')).toBe('<p>Salt</p>');
    });

    it('unwraps a disallowed element but keeps its text', () => {
        expect(sanitizeDescription('<p><iframe>Salt</iframe></p>')).toBe('<p>Salt</p>');
    });

    it('keeps an http link', () => {
        const html = '<p><a href="https://example.com/portal">Portal</a></p>';
        expect(sanitizeDescription(html)).toBe(
            '<p><a href="https://example.com/portal" target="_blank" rel="noopener noreferrer">Portal</a></p>',
        );
    });

    it('strips a javascript: link back to its text', () => {
        expect(sanitizeDescription('<p><a href="javascript:alert(1)">Tap</a></p>')).toBe(
            '<p>Tap</p>',
        );
    });

    /*
     * Quill leaves one of these behind whenever the editor has been opened and
     * emptied again, and Donetick stores it verbatim. Rendering it would give
     * the row a band with nothing in it.
     */
    it('returns nothing for markup that holds no text', () => {
        expect(sanitizeDescription('<p><br></p>')).toBe('');
    });

    it('keeps a line break that sits alongside text', () => {
        expect(sanitizeDescription('<p>Pause syncing<br>Resume syncing</p>')).toBe(
            '<p>Pause syncing<br>Resume syncing</p>',
        );
    });
});
