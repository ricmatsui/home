/*
 * The build-time variables this app reads. Declared here rather than by
 * referencing vite/client, whose ImportMetaEnv carries an index signature that
 * types every misspelling as valid.
 */
interface ImportMetaEnv {
    // The roster, as JSON: [{"name":"Jane","id":1},{"name":"John","id":2}].
    // Optional — unset means the board keeps its single unattributed Done.
    readonly VITE_TICKER_USERS?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
