/*
 * The build-time variables this app reads. Declared here rather than by
 * referencing vite/client, whose ImportMetaEnv carries an index signature that
 * types every misspelling as valid.
 */
interface ImportMetaEnv {
    // The roster, as JSON: [{"name":"Jane","id":1},{"name":"John","id":2}].
    // Optional — unset means the board keeps its single unattributed Done.
    readonly VITE_TICKER_USERS?: string;
    // Donetick as the browser reaches it: https://donetick.example.com. The
    // board's own requests go through nginx, so this is only for links.
    // Optional — unset means chore names are plain text.
    readonly VITE_DONETICK_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
