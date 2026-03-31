import fs from 'fs';
import path from 'path';
import { simpleGit } from 'simple-git';
import { Status, TodoItem, Section, Action } from './types.js';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
}

const env = {
    get WIKI_PATH() { return requireEnv('WIKI_PATH'); },
    get WIKI_REMOTE() { return requireEnv('WIKI_REMOTE'); },
    get DOMAIN() { return requireEnv('DOMAIN'); },
};

export function resolveNextDate(mmdd: string, referenceDate: Date): string {
    const [mm, dd] = mmdd.split('-').map(Number);
    const refYear = referenceDate.getUTCFullYear();
    const refMonth = referenceDate.getUTCMonth() + 1;
    const refDay = referenceDate.getUTCDate();

    let year = refYear;
    if (mm < refMonth || (mm === refMonth && dd <= refDay)) {
        year++;
    }

    return formatDateStr(new Date(year, mm - 1, dd));
}

const ACTION_PATTERN = /^-> Move to (\d{2}-\d{2})$/;

function parseAction(text: string): { kind: 'moveTo'; mmdd: string } | null {
    const match = text.match(ACTION_PATTERN);
    if (!match) return null;
    return { kind: 'moveTo', mmdd: match[1] };
}

function cloneAncestorChain(ancestors: TodoItem[], leafChildren: TodoItem[]): TodoItem {
    let current: TodoItem = {
        status: 'incomplete',
        text: ancestors[ancestors.length - 1].text,
        children: leafChildren,
    };

    for (let i = ancestors.length - 2; i >= 0; i--) {
        current = {
            status: 'incomplete',
            text: ancestors[i].text,
            children: [current],
        };
    }

    return current;
}

function extractActionsFromItem(
    item: TodoItem,
    ancestors: TodoItem[],
    sectionName: string,
    referenceDate: Date,
    actions: Action[],
): void {
    const path = [...ancestors, item];

    for (const child of item.children) {
        const parsed = parseAction(child.text);
        if (parsed) {
            const targetDate = resolveNextDate(parsed.mmdd, referenceDate);
            const cloned = cloneAncestorChain(path, []);
            actions.push({ kind: 'addItem', targetDate, sectionName, item: cloned });
            child.status = 'completed';
            item.status = 'completed';
        } else {
            extractActionsFromItem(child, path, sectionName, referenceDate, actions);
        }
    }
}

export function extractActions(
    sections: Section[],
    referenceDate: Date,
): { sections: Section[]; actions: Action[] } {
    const actions: Action[] = [];

    for (const section of sections) {
        for (const item of section.items) {
            extractActionsFromItem(item, [], section.name, referenceDate, actions);
        }
    }

    return { sections, actions };
}

export async function unlockWikiIfPossible(): Promise<void> {
    try {
        const lockFile = path.resolve(env.WIKI_PATH, '.git', 'index.lock');
        const stat = await fs.promises.stat(lockFile);
        const ageMs = Date.now() - stat.mtimeMs;

        console.warn(`Existing index.lock (age: ${Math.round(ageMs / 1000 / 60)}m)`);

        if (ageMs < 60 * 60 * 1000) {
            throw new Error('Wiki repo is locked');
        }

        console.log('Removing index.lock');
        await fs.promises.unlink(lockFile);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return;
        }

        throw error;
    }
}

export function formatDateStr(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export interface TodoFileInfo {
    todoId: string;
    todoPath: string;
    todoContent: string;
}

export async function readTodoFile(): Promise<TodoFileInfo> {

    const indexContent = await fs.promises.readFile(path.resolve(env.WIKI_PATH, 'index.md'), 'utf-8');
    const todoMatch = indexContent.match(/\[TODO\]\(([^)]+)\)/);
    if (!todoMatch) {
        throw new Error('TODO link not found in index.md');
    }

    const todoId = todoMatch[1];
    const todoPath = path.resolve(env.WIKI_PATH, `${todoId}.md`);
    const todoContent = await fs.promises.readFile(todoPath, 'utf-8');

    return { todoId, todoPath, todoContent };
}

export function parseDayFile(content: string): Section[] {
    const body = content.replace(/^---[\s\S]*?---\s*/, '');

    const sections: Section[] = [];
    let currentSection: Section | null = null;
    let codeBlockBuffer: string[] | null = null;
    let codeBlockIndent = 0;

    function ensureSection(): Section {
        if (!currentSection) {
            currentSection = { name: 'Other', items: [] };
            sections.push(currentSection);
        }
        return currentSection;
    }

    function addItem(item: TodoItem, depth: number): void {
        const section = ensureSection();
        if (depth === 0) {
            section.items.push(item);
            return;
        }

        let parent = section.items[section.items.length - 1];
        for (let i = 1; i < depth && parent; i++) {
            parent = parent.children[parent.children.length - 1];
        }

        if (parent) {
            parent.children.push(item);
        } else {
            section.items.push(item);
        }
    }

    for (const line of body.split('\n')) {
        // Handle code block accumulation
        if (codeBlockBuffer !== null) {
            codeBlockBuffer.push(line.slice(codeBlockIndent));
            if (line.trim() === '```') {
                addItem({ status: 'note', text: codeBlockBuffer.join('\n'), children: [] }, Math.floor(codeBlockIndent / 4));
                codeBlockBuffer = null;
            }
            continue;
        }

        // Detect code block opening
        const codeBlockOpen = line.match(/^(\s*)```/);
        if (codeBlockOpen) {
            codeBlockIndent = codeBlockOpen[1].length;
            codeBlockBuffer = [line.slice(codeBlockIndent)];
            continue;
        }

        const headingMatch = line.match(/^#\s+(.+)/);
        if (headingMatch) {
            currentSection = { name: headingMatch[1].trim(), items: [] };
            sections.push(currentSection);
            continue;
        }

        if (!line.trim()) continue;

        const checkboxMatch = line.match(/^(\s*)- \[([ xX.\-])\] (.+)/);
        const noteMatch = line.match(/^(\s*)- ([^\[].*)$/);
        const plainMatch = !checkboxMatch && !noteMatch ? line.match(/^(\s*)(.+)/) : null;

        if (!checkboxMatch && !noteMatch && !plainMatch) continue;

        const indent = (checkboxMatch?.[1] ?? noteMatch?.[1] ?? plainMatch![1]).length;

        let status: Status;
        let text: string;

        if (checkboxMatch) {
            const marker = checkboxMatch[2];
            status = marker === ' ' ? 'incomplete' : marker === '.' ? 'started' : marker === '-' ? 'rejected' : 'completed';
            text = checkboxMatch[3].trim();
        } else if (noteMatch) {
            status = 'note';
            text = noteMatch[2].trim();
        } else {
            status = 'note';
            text = plainMatch![2].trim();
        }

        addItem({ status, text, children: [] }, Math.floor(indent / 4));
    }

    return sections;
}

function statusToMarker(status: Status): string {
    switch (status) {
        case 'incomplete': return '[ ]';
        case 'started': return '[.]';
        case 'completed': return '[X]';
        case 'rejected': return '[-]';
        case 'note': return '';
    }
}

function serializeItem(item: TodoItem, depth: number): string {
    const indent = '    '.repeat(depth);

    // Multiline text (code blocks) - output raw with indentation per line
    if (item.text.includes('\n')) {
        let result = item.text.split('\n').map(l => indent + l).join('\n') + '\n';
        for (const child of item.children) {
            result += serializeItem(child, depth + 1);
        }
        return result;
    }

    const marker = statusToMarker(item.status);
    const prefix = marker ? `- ${marker} ` : '- ';
    let result = `${indent}${prefix}${item.text}\n`;
    for (const child of item.children) {
        result += serializeItem(child, depth + 1);
    }
    return result;
}

export function serializeSections(sections: Section[]): string {
    const parts: string[] = [];
    for (const section of sections) {
        parts.push(`# ${section.name}\n`);
        for (const item of section.items) {
            parts.push(serializeItem(item, 0));
        }
        parts.push('');
    }
    return parts.join('\n');
}

export async function commitWiki(message: string): Promise<void> {
    console.log('Committing wiki');
    const git = simpleGit({ baseDir: path.resolve(env.WIKI_PATH) });
    await git.addConfig('user.name', 'Planner');
    await git.addConfig('user.email', `planner@${env.DOMAIN}`);
    await git.add(['.']);
    await git.commit(message);
    console.log('Committed wiki');
}

export async function writeDayFile(filePath: string, sections: Section[]): Promise<void> {
    const existing = await fs.promises.readFile(filePath, 'utf-8');
    const frontmatterMatch = existing.match(/^---[\s\S]*?---\n/);
    const frontmatter = frontmatterMatch ? frontmatterMatch[0] : '';

    const content = frontmatter + '\n' + serializeSections(sections);
    await fs.promises.writeFile(filePath, content, 'utf-8');
}

function partitionItem(item: TodoItem, parent: TodoItem | null = null): { last: TodoItem | null; next: TodoItem | null } {
    if (item.children.length === 0) {
        switch (item.status) {
            case 'completed':
            case 'rejected':
                return { last: { ...item, children: [] }, next: null };
            case 'incomplete':
                return { last: null, next: { ...item, children: [] } };
            case 'started':
                return {
                    last: { ...item, status: 'completed', children: [] },
                    next: { ...item, children: [] },
                };
            case 'note':
                // Notes under a completed/rejected parent stay with last, not carried over
                if (parent?.status === 'completed' || parent?.status === 'rejected') {
                    return { last: { ...item, children: [] }, next: null };
                }
                return { last: null, next: { ...item, children: [] } };
        }
    }

    const lastChildren: TodoItem[] = [];
    const nextChildren: TodoItem[] = [];

    for (const child of item.children) {
        const { last, next } = partitionItem(child, item);
        if (last) lastChildren.push(last);
        if (next) nextChildren.push(next);
    }

    const isDone = item.status === 'completed' || item.status === 'rejected';
    const lastStatus: Status = item.status === 'rejected' ? 'rejected' : 'completed';

    const last: TodoItem | null =
        lastChildren.length > 0 || isDone
            ? { status: lastStatus, text: item.text, children: lastChildren }
            : item.status === 'started'
                ? { status: 'completed', text: item.text, children: [] }
                : null;

    const nextStatus: Status =
        item.status === 'note' ? 'note'
            : item.status === 'started' && nextChildren.some(c => c.status === 'started') ? 'started'
                : 'incomplete';

    const next: TodoItem | null =
        nextChildren.length > 0 || !isDone
            ? { status: nextStatus, text: item.text, children: nextChildren }
            : null;

    return { last, next };
}

export function partitionSections(sections: Section[]): { lastData: Section[]; nextData: Section[] } {
    const lastData: Section[] = [];
    const nextData: Section[] = [];

    for (const section of sections) {
        const lastItems: TodoItem[] = [];
        const nextItems: TodoItem[] = [];

        for (const item of section.items) {
            const { last, next } = partitionItem(item);
            if (last) lastItems.push(last);
            if (next) nextItems.push(next);
        }

        lastData.push({ name: section.name, items: lastItems });
        nextData.push({ name: section.name, items: nextItems });
    }

    return { lastData, nextData };
}

export async function createDayFile(todoFile: TodoFileInfo, dateStr: string): Promise<string> {
    if (!todoFile.todoContent.includes(dateStr)) {
        throw new Error(`Date ${dateStr} not found in TODO file`);
    }

    const now = new Date();
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    let fileId = `${yy}${mm}${dd}-${hh}${mi}`;

    let filePath = path.resolve(env.WIKI_PATH, `${fileId}.md`);
    const suffixes = 'abcdefghijklmnopqrstuvwxyz';
    let suffixIdx = 0;
    while (await fs.promises.stat(filePath).then(() => true, () => false)) {
        fileId = `${yy}${mm}${dd}-${hh}${mi}${suffixes[suffixIdx]}`;
        filePath = path.resolve(env.WIKI_PATH, `${fileId}.md`);
        suffixIdx++;
    }

    const createdDate = `${formatDateStr(now)} ${hh}:${mi}`;
    const content = [
        '---',
        `title: ${dateStr}`,
        'tags: :zettel:',
        `date: ${createdDate}`,
        `parent: [TODO](${todoFile.todoId})`,
        '---',
        '',
        '',
    ].join('\n');

    await fs.promises.writeFile(filePath, content, 'utf-8');

    const updatedTodo = todoFile.todoContent.replace(
        new RegExp(`(- \\[[ xX.]\\] )${dateStr}(.*)$`, 'm'),
        `$1[${dateStr}](${fileId})$2`,
    );
    await fs.promises.writeFile(todoFile.todoPath, updatedTodo, 'utf-8');

    return filePath;
}

export async function markDayAsDone(todoFile: TodoFileInfo, dateStr: string): Promise<void> {
    const updated = todoFile.todoContent.replace(
        new RegExp(`(- \\[)[ .]\\] (.*${dateStr}.*)`, 'm'),
        '$1X] $2',
    );
    if (updated === todoFile.todoContent) return;
    await fs.promises.writeFile(todoFile.todoPath, updated, 'utf-8');
}

export function findDayFilePath(todoFile: TodoFileInfo, dateStr: string): string | null {
    const match = todoFile.todoContent.match(new RegExp(`\\[${dateStr}\\]\\(([^)]+)\\)`));
    if (!match) {
        return null;
    }
    return path.resolve(env.WIKI_PATH, `${match[1]}.md`);
}

export async function pushWiki(): Promise<void> {
    console.log('Pushing wiki');
    const git = simpleGit({ baseDir: path.resolve(env.WIKI_PATH) });
    await git.push(env.WIKI_REMOTE, 'main');
    console.log('Pushed wiki');
}
