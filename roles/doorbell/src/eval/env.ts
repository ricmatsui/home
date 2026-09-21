import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads `<dir>/.env` into the environment, reporting whether there was one. Node
 * leaves variables that are already set alone, so an exported LM_STUDIO_URL still
 * beats the file and the file still beats the built-in default. Absent is the
 * normal case in the container, which is configured by the stack instead.
 */
export function loadDotEnv(dir: string): boolean {
    const file = path.join(dir, '.env');
    if (!fs.existsSync(file)) return false;

    process.loadEnvFile(file);
    return true;
}
