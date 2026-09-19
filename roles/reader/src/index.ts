import { createServer } from './server.js';

const wikiPath = process.env.WIKI_PATH ?? '/wiki';
const port = Number(process.env.PORT ?? '8080');

createServer({ wikiPath }).listen(port, () => {
    console.log(`reader listening on ${port}, serving ${wikiPath}`);
});
