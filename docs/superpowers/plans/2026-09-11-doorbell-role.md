# Doorbell Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `roles/doorbell` — a Node/TypeScript service that enables the Frigate `front_door` camera only while Nest doorbell events are arriving, and during that window samples go2rtc frames through a local gemma vision model to publish cat presence to Home Assistant over MQTT.

**Architecture:** One container, one process, all state in memory. A Pub/Sub streaming-pull subscriber slides a 2-minute activity window; the window drives both the Frigate MQTT command and a 30s frame poll. Sampled frames go through a bounded serial queue into LM Studio, and results become MQTT state plus annotated JPEGs on GlusterFS. A crash loses nothing that matters, because boot reconciles everything to OFF.

**Tech Stack:** Node 24, TypeScript 5.9 (ESM, `NodeNext`), yarn 1.22, `node:test`, `@google-cloud/pubsub` 6, `@lmstudio/sdk` 1.5, `zod` 3, `mqtt` 5, `jimp` 1.6, Docker Swarm via Ansible.

**Spec:** `docs/superpowers/specs/2026-09-11-doorbell-design.md`

## Global Constraints

- **Node 24.** Image is `node:24.14-trixie` pinned by digest, matching `roles/planner`. `.node-version` contains `24`.
- **yarn 1.22 classic, `--frozen-lockfile` in the image build.** No dependency may ship platform-specific binaries as optional dependencies — yarn 1 records only the host platform's, so an arm64-generated lockfile then fails the amd64 build. This is why the plan uses `jimp`, not `sharp`.
- **zod 3, not zod 4.** `@lmstudio/sdk@1.5.0` depends on `zod@^3.22.4` and extracts a JSON schema from the schema object it is handed. Two zod majors in one tree is the breakage its own typings warn about. Use `^3.25.76`.
- **ESM throughout.** `"type": "module"`, `module`/`moduleResolution` both `NodeNext`, so every relative import ends in `.js` even though the source is `.ts`.
- **Tests are `src/*.test.ts`, compiled to `dist` and run with `node --test dist/*.test.js`,** exactly as `roles/planner` does. Tests run under `TZ=America/Los_Angeles`.
- **Working directory matters.** `yarn` commands run from `roles/doorbell`; `task deploy` runs from the repo root, where the tasksfile and the direnv environment that puts `task` on `PATH` both live. From inside a role directory, `task` is not found.
- **No network in tests.** Every boundary (Pub/Sub, go2rtc, LM Studio, MQTT) is injected.
- **Exact literal values** (these are configuration, do not invent substitutes):
  - Pub/Sub subscription: `<redacted>`
  - Nest device ID: `<redacted>`
  - LM Studio: `<redacted>`, model `gemma-3-12b-it-qat`
  - go2rtc: `http://go2rtc:1984`, stream `front_door`
  - MQTT: `mqtt://mosquitto:1883`, Frigate camera `front_door`
  - Window 120000ms, poll 30000ms, miss limit 3, queue max 4, frames at `/frames`
  - The gemma prompt, verbatim: `Provide the bounding box coordinates for detect all cats. Report strictly in JSON format as a list of objects with 'label' and 'bbox_2d' (xmin, ymin, xmax, ymax in 0-1000 scale). If there are not cats, return empty list.`

## File Structure

| File | Responsibility |
|---|---|
| `roles/doorbell/package.json`, `tsconfig.json`, `.node-version`, `.gitignore`, `.dockerignore`, `.envrc` | project setup, mirroring `roles/planner` |
| `roles/doorbell/Dockerfile` | build image |
| `roles/doorbell/src/config.ts` | env parsing |
| `roles/doorbell/src/events.ts` | Pub/Sub subscribe + pure doorbell-event filter |
| `roles/doorbell/src/window.ts` | activity window: open, slide, tick, close |
| `roles/doorbell/src/presence.ts` | cat presence latch and miss counter |
| `roles/doorbell/src/queue.ts` | bounded serial work queue, evict-oldest |
| `roles/doorbell/src/vision.ts` | LM Studio call, zod schema, box scaling, cat predicate |
| `roles/doorbell/src/annotate.ts` | frame paths, box drawing, result writing |
| `roles/doorbell/src/frames.ts` | go2rtc frame grab + raw write |
| `roles/doorbell/src/mqtt.ts` | MQTT client, HA discovery payloads, publishers |
| `roles/doorbell/src/index.ts` | wiring, shutdown |
| `roles/doorbell/defaults/main.yml`, `tasks/main.yml`, `README.md` | Ansible role |
| `playbook.yml`, `README.md` | repo wiring |

---

### Task 1: Project scaffold and configuration

**Files:**
- Create: `roles/doorbell/package.json`, `roles/doorbell/tsconfig.json`, `roles/doorbell/.node-version`, `roles/doorbell/.gitignore`, `roles/doorbell/.dockerignore`, `roles/doorbell/.envrc`, `roles/doorbell/Dockerfile`
- Create: `roles/doorbell/src/config.ts`
- Test: `roles/doorbell/src/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadConfig(env?): Config`, `requireEnv(name, env?): string`, and the `Config` / `GoogleCredentials` interfaces used by every later task.

- [ ] **Step 1: Create the project files**

`roles/doorbell/package.json`:

```json
{
    "name": "doorbell",
    "version": "1.0.0",
    "license": "MIT",
    "type": "module",
    "scripts": {
        "build": "tsc || exit 1",
        "test": "rm -rf dist && tsc && TZ=America/Los_Angeles node --test dist/*.test.js",
        "start": "node dist/index.js"
    },
    "dependencies": {
        "@google-cloud/pubsub": "^6.0.1",
        "@lmstudio/sdk": "^1.5.0",
        "jimp": "^1.6.1",
        "mqtt": "^5.15.2",
        "zod": "^3.25.76"
    },
    "devDependencies": {
        "@types/node": "^24.13.3",
        "typescript": "^5.9.3"
    }
}
```

`roles/doorbell/tsconfig.json`:

```json
{
    "compilerOptions": {
        "target": "esnext",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "strict": true,
        "skipLibCheck": true,
        "esModuleInterop": true,
        "outDir": "dist"
    },
    "include": ["src"]
}
```

`roles/doorbell/.node-version`:

```
24
```

`roles/doorbell/.gitignore`:

```
dist/
node_modules/
```

`roles/doorbell/.dockerignore`:

```
node_modules
dist
.git
.DS_Store
```

`roles/doorbell/.envrc`:

```bash
use_fnm() {
  fnm use --install-if-missing
}

use fnm
PATH_add node_modules/.bin
```

`roles/doorbell/Dockerfile`:

```dockerfile
FROM node:24.14-trixie@sha256:81649592d9833d9220423561fc517b34e932b751873274024c2a969ff4a9bfc2

WORKDIR /home/node/app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./

RUN yarn run build

USER node

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Install dependencies**

Run from `roles/doorbell`:

```bash
yarn install
```

Expected: creates `yarn.lock` and `node_modules`. Confirm `yarn.lock` exists — the Dockerfile's `--frozen-lockfile` needs it committed.

- [ ] **Step 3: Write the failing test**

`roles/doorbell/src/config.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, requireEnv } from './config.js';

const credentials = JSON.stringify({
    client_email: '<redacted>',
    private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
    project_id: '<redacted>',
});

const validEnv = {
    GOOGLE_CREDENTIALS_JSON: credentials,
    PUBSUB_SUBSCRIPTION: '<redacted>',
    NEST_DEVICE_ID: 'DEVICE',
    GO2RTC_URL: 'http://go2rtc:1984',
    GO2RTC_STREAM: 'front_door',
    LM_STUDIO_URL: '<redacted>',
    LM_STUDIO_MODEL: 'gemma-3-12b-it-qat',
    MQTT_URL: 'mqtt://mosquitto:1883',
    FRIGATE_CAMERA: 'front_door',
    WINDOW_MS: '120000',
    POLL_MS: '30000',
    MISS_LIMIT: '3',
    QUEUE_MAX: '4',
    FRAMES_PATH: '/frames',
};

test('requireEnv returns the value', () => {
    assert.equal(requireEnv('A', { A: 'b' }), 'b');
});

test('requireEnv throws when unset', () => {
    assert.throws(() => requireEnv('A', {}), /A is not set/);
});

test('loadConfig parses numbers and credentials', () => {
    const config = loadConfig(validEnv);

    assert.equal(config.windowMs, 120000);
    assert.equal(config.pollMs, 30000);
    assert.equal(config.missLimit, 3);
    assert.equal(config.queueMax, 4);
    assert.equal(config.googleCredentials.project_id, '<redacted>');
    assert.equal(config.frigateCamera, 'front_door');
});

test('loadConfig rejects credentials without a private key', () => {
    const env = { ...validEnv, GOOGLE_CREDENTIALS_JSON: JSON.stringify({ client_email: 'a@b.c' }) };

    assert.throws(() => loadConfig(env), /client_email or private_key/);
});

test('loadConfig rejects a non-numeric interval', () => {
    const env = { ...validEnv, POLL_MS: 'soon' };

    assert.throws(() => loadConfig(env), /POLL_MS is not a number/);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd roles/doorbell && yarn test`
Expected: FAIL — `Cannot find module './config.js'` (compile error from `tsc`).

- [ ] **Step 5: Write the implementation**

`roles/doorbell/src/config.ts`:

```typescript
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
}

function requireNumber(name: string, env: NodeJS.ProcessEnv): number {
    const value = Number(requireEnv(name, env));
    if (!Number.isFinite(value)) throw new Error(`${name} is not a number`);
    return value;
}

export interface GoogleCredentials {
    client_email: string;
    private_key: string;
    project_id: string;
}

export interface Config {
    pubsubSubscription: string;
    googleCredentials: GoogleCredentials;
    nestDeviceId: string;
    go2rtcUrl: string;
    go2rtcStream: string;
    lmStudioUrl: string;
    lmStudioModel: string;
    mqttUrl: string;
    frigateCamera: string;
    windowMs: number;
    pollMs: number;
    missLimit: number;
    queueMax: number;
    framesPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const googleCredentials = JSON.parse(requireEnv('GOOGLE_CREDENTIALS_JSON', env)) as GoogleCredentials;
    if (!googleCredentials.client_email || !googleCredentials.private_key) {
        throw new Error('GOOGLE_CREDENTIALS_JSON is missing client_email or private_key');
    }

    return {
        pubsubSubscription: requireEnv('PUBSUB_SUBSCRIPTION', env),
        googleCredentials,
        nestDeviceId: requireEnv('NEST_DEVICE_ID', env),
        go2rtcUrl: requireEnv('GO2RTC_URL', env),
        go2rtcStream: requireEnv('GO2RTC_STREAM', env),
        lmStudioUrl: requireEnv('LM_STUDIO_URL', env),
        lmStudioModel: requireEnv('LM_STUDIO_MODEL', env),
        mqttUrl: requireEnv('MQTT_URL', env),
        frigateCamera: requireEnv('FRIGATE_CAMERA', env),
        windowMs: requireNumber('WINDOW_MS', env),
        pollMs: requireNumber('POLL_MS', env),
        missLimit: requireNumber('MISS_LIMIT', env),
        queueMax: requireNumber('QUEUE_MAX', env),
        framesPath: requireEnv('FRAMES_PATH', env),
    };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd roles/doorbell && yarn test`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add roles/doorbell
git commit -m "Add doorbell project scaffold and config"
```

---

### Task 2: Nest event filter and Pub/Sub subscriber

**Files:**
- Create: `roles/doorbell/src/events.ts`
- Test: `roles/doorbell/src/events.test.ts`

**Interfaces:**
- Consumes: `GoogleCredentials` from `config.ts`.
- Produces: `parseDoorbellEvent(data: string, deviceId: string): DoorbellEvent | null`, `subscribeToDoorbellEvents(options): EventSubscription`, `DOORBELL_EVENT_TYPES`, and the `DoorbellEvent` / `EventSubscription` interfaces.

**Background:** a Nest SDM Pub/Sub message body looks like this. Note that `relationUpdate` messages (device added/removed) carry no `resourceUpdate` at all, and that other devices in the Device Access project publish to the same topic.

```json
{
  "eventId": "1234-5678",
  "timestamp": "2026-09-11T18:00:00.000Z",
  "resourceUpdate": {
    "name": "enterprises/PROJECT/devices/DEVICE_ID",
    "events": {
      "sdm.devices.events.CameraMotion.Motion": { "eventSessionId": "x", "eventId": "y" }
    }
  },
  "userId": "AVPH..."
}
```

- [ ] **Step 1: Write the failing test**

`roles/doorbell/src/events.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoorbellEvent } from './events.js';

const DEVICE_ID = 'AVPHwEsZn3GEJbracJ82Ilyg';

function message(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        eventId: 'event-1',
        timestamp: '2026-09-11T18:00:00.000Z',
        resourceUpdate: {
            name: `enterprises/project/devices/${DEVICE_ID}`,
            events: { 'sdm.devices.events.CameraMotion.Motion': { eventSessionId: 's' } },
        },
        ...overrides,
    });
}

test('accepts each doorbell event type', () => {
    for (const type of [
        'sdm.devices.events.DoorbellChime.Chime',
        'sdm.devices.events.CameraMotion.Motion',
        'sdm.devices.events.CameraPerson.Person',
        'sdm.devices.events.CameraSound.Sound',
    ]) {
        const data = message({
            resourceUpdate: { name: `enterprises/project/devices/${DEVICE_ID}`, events: { [type]: {} } },
        });

        assert.deepEqual(parseDoorbellEvent(data, DEVICE_ID)?.types, [type]);
    }
});

test('returns the event id and timestamp', () => {
    const event = parseDoorbellEvent(message(), DEVICE_ID);

    assert.equal(event?.eventId, 'event-1');
    assert.equal(event?.timestamp, '2026-09-11T18:00:00.000Z');
});

test('rejects another device', () => {
    const data = message({
        resourceUpdate: {
            name: 'enterprises/project/devices/SOMEOTHERDEVICE',
            events: { 'sdm.devices.events.CameraMotion.Motion': {} },
        },
    });

    assert.equal(parseDoorbellEvent(data, DEVICE_ID), null);
});

test('rejects a device id that is only a suffix of the real one', () => {
    const data = message({
        resourceUpdate: {
            name: `enterprises/project/devices/PREFIX${DEVICE_ID}`,
            events: { 'sdm.devices.events.CameraMotion.Motion': {} },
        },
    });

    assert.equal(parseDoorbellEvent(data, DEVICE_ID), null);
});

test('rejects unrelated event types', () => {
    const data = message({
        resourceUpdate: {
            name: `enterprises/project/devices/${DEVICE_ID}`,
            events: { 'sdm.devices.events.ThermostatTemperature.Change': {} },
        },
    });

    assert.equal(parseDoorbellEvent(data, DEVICE_ID), null);
});

test('rejects a relation update with no resourceUpdate', () => {
    const data = JSON.stringify({ eventId: 'e', relationUpdate: { subject: 'x', object: 'y' } });

    assert.equal(parseDoorbellEvent(data, DEVICE_ID), null);
});

test('rejects malformed json without throwing', () => {
    assert.equal(parseDoorbellEvent('not json', DEVICE_ID), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd roles/doorbell && yarn test`
Expected: FAIL — cannot find `./events.js`.

- [ ] **Step 3: Write the implementation**

`roles/doorbell/src/events.ts`:

```typescript
import { PubSub } from '@google-cloud/pubsub';
import { GoogleCredentials } from './config.js';

export const DOORBELL_EVENT_TYPES: readonly string[] = [
    'sdm.devices.events.DoorbellChime.Chime',
    'sdm.devices.events.CameraMotion.Motion',
    'sdm.devices.events.CameraPerson.Person',
    'sdm.devices.events.CameraSound.Sound',
];

export interface DoorbellEvent {
    eventId: string;
    timestamp: string;
    types: string[];
}

export function parseDoorbellEvent(data: string, deviceId: string): DoorbellEvent | null {
    let message: Record<string, any>;
    try {
        message = JSON.parse(data);
    } catch {
        return null;
    }
    if (typeof message !== 'object' || message === null) return null;

    const name: unknown = message.resourceUpdate?.name;
    if (typeof name !== 'string' || !name.endsWith(`/${deviceId}`)) return null;

    const events: unknown = message.resourceUpdate?.events;
    if (typeof events !== 'object' || events === null) return null;

    const types = Object.keys(events).filter((type) => DOORBELL_EVENT_TYPES.includes(type));
    if (types.length === 0) return null;

    return {
        eventId: String(message.eventId ?? ''),
        timestamp: String(message.timestamp ?? ''),
        types,
    };
}

export interface EventSubscription {
    close(): Promise<void>;
}

export function subscribeToDoorbellEvents(options: {
    subscription: string;
    credentials: GoogleCredentials;
    deviceId: string;
    onEvent: (event: DoorbellEvent) => void;
    onFatal: (error: Error) => void;
}): EventSubscription {
    const pubsub = new PubSub({
        projectId: options.credentials.project_id,
        credentials: options.credentials,
    });

    const subscription = pubsub.subscription(options.subscription, {
        flowControl: { maxMessages: 20 },
    });

    subscription.on('message', (message) => {
        try {
            const event = parseDoorbellEvent(message.data.toString(), options.deviceId);
            if (event) {
                console.log(`event ${event.eventId} ${event.types.join(',')}`);
                options.onEvent(event);
            }
        } catch (error) {
            console.error('failed to handle message', error);
        } finally {
            // Ack unconditionally: these are notifications, and a poison message
            // must not wedge the subscription.
            message.ack();
        }
    });

    subscription.on('error', (error: Error) => {
        options.onFatal(error);
    });

    return {
        async close(): Promise<void> {
            await subscription.close();
            await pubsub.close();
        },
    };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd roles/doorbell && yarn test`
Expected: PASS, 12 tests total.

- [ ] **Step 5: Commit**

```bash
git add roles/doorbell/src
git commit -m "Add Nest doorbell event filter and Pub/Sub subscriber"
```

---

### Task 3: Activity window

**Files:**
- Create: `roles/doorbell/src/window.ts`
- Test: `roles/doorbell/src/window.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class ActivityWindow` with `onEvent(): void`, `close(): void`, `get isOpen(): boolean`, constructed as `new ActivityWindow({ windowMs, pollMs, callbacks: { onOpen, onTick, onClose } })`.

**Testing note:** the implementation uses plain `setTimeout`/`setInterval`; tests drive them with `node:test`'s built-in timer mocking (`t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })` and `t.mock.timers.tick(ms)`). Do not add a clock-injection parameter — the mock covers it.

- [ ] **Step 1: Write the failing test**

`roles/doorbell/src/window.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityWindow } from './window.js';

function build() {
    const calls = { open: 0, tick: 0, close: 0 };
    const activityWindow = new ActivityWindow({
        windowMs: 120_000,
        pollMs: 30_000,
        callbacks: {
            onOpen: () => { calls.open += 1; },
            onTick: () => { calls.tick += 1; },
            onClose: () => { calls.close += 1; },
        },
    });
    return { calls, activityWindow };
}

test('first event opens the window and ticks immediately', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { calls, activityWindow } = build();

    activityWindow.onEvent();

    assert.equal(calls.open, 1);
    assert.equal(calls.tick, 1);
    assert.equal(activityWindow.isOpen, true);
});

test('ticks on the poll interval while open', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { calls, activityWindow } = build();

    activityWindow.onEvent();
    t.mock.timers.tick(30_000);
    t.mock.timers.tick(30_000);

    assert.equal(calls.tick, 3);
});

test('a second event does not reopen the window but slides expiry', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { calls, activityWindow } = build();

    activityWindow.onEvent();
    t.mock.timers.tick(119_000);
    activityWindow.onEvent();
    t.mock.timers.tick(119_000);

    assert.equal(calls.open, 1);
    assert.equal(calls.close, 0);
    assert.equal(activityWindow.isOpen, true);
});

test('closes after the window elapses with no events', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { calls, activityWindow } = build();

    activityWindow.onEvent();
    t.mock.timers.tick(120_000);

    assert.equal(calls.close, 1);
    assert.equal(activityWindow.isOpen, false);
});

test('stops ticking once closed', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { calls, activityWindow } = build();

    activityWindow.onEvent();
    t.mock.timers.tick(120_000);
    const ticksAtClose = calls.tick;
    t.mock.timers.tick(300_000);

    assert.equal(calls.tick, ticksAtClose);
});

test('reopens after a close', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { calls, activityWindow } = build();

    activityWindow.onEvent();
    t.mock.timers.tick(120_000);
    activityWindow.onEvent();

    assert.equal(calls.open, 2);
    assert.equal(activityWindow.isOpen, true);
});

test('close is idempotent', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { calls, activityWindow } = build();

    activityWindow.onEvent();
    activityWindow.close();
    activityWindow.close();

    assert.equal(calls.close, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd roles/doorbell && yarn test`
Expected: FAIL — cannot find `./window.js`.

- [ ] **Step 3: Write the implementation**

`roles/doorbell/src/window.ts`:

```typescript
export interface WindowCallbacks {
    onOpen: () => void;
    onTick: () => void;
    onClose: () => void;
}

/**
 * An activity window held open by incoming events. The first event opens it and
 * ticks immediately; every later event slides expiry out again. When it expires,
 * everything stops.
 */
export class ActivityWindow {
    readonly #windowMs: number;
    readonly #pollMs: number;
    readonly #callbacks: WindowCallbacks;

    #expiryTimer: NodeJS.Timeout | null = null;
    #tickTimer: NodeJS.Timeout | null = null;
    #open = false;

    constructor(options: { windowMs: number; pollMs: number; callbacks: WindowCallbacks }) {
        this.#windowMs = options.windowMs;
        this.#pollMs = options.pollMs;
        this.#callbacks = options.callbacks;
    }

    get isOpen(): boolean {
        return this.#open;
    }

    onEvent(): void {
        if (!this.#open) {
            this.#open = true;
            this.#callbacks.onOpen();
            this.#callbacks.onTick();
            this.#tickTimer = setInterval(() => this.#callbacks.onTick(), this.#pollMs);
        }

        if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
        this.#expiryTimer = setTimeout(() => this.close(), this.#windowMs);
    }

    close(): void {
        if (!this.#open) return;
        this.#open = false;

        if (this.#expiryTimer) {
            clearTimeout(this.#expiryTimer);
            this.#expiryTimer = null;
        }
        if (this.#tickTimer) {
            clearInterval(this.#tickTimer);
            this.#tickTimer = null;
        }

        this.#callbacks.onClose();
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd roles/doorbell && yarn test`
Expected: PASS, 19 tests total.

- [ ] **Step 5: Commit**

```bash
git add roles/doorbell/src
git commit -m "Add doorbell activity window"
```

---

### Task 4: Cat presence latch

**Files:**
- Create: `roles/doorbell/src/presence.ts`
- Test: `roles/doorbell/src/presence.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class CatPresence` with `recordDetection(hasCat: boolean): void`, `reset(): void`, `get present(): boolean`, constructed as `new CatPresence({ missLimit, onChange })`.

**Design note:** `onChange` fires only on a transition, so callers can publish straight to MQTT without spamming the topic. Failed grabs and failed inferences must never reach `recordDetection` — they are not evidence about the cat. The caller enforces that by simply not calling it (see Task 10).

- [ ] **Step 1: Write the failing test**

`roles/doorbell/src/presence.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatPresence } from './presence.js';

function build(missLimit = 3) {
    const changes: boolean[] = [];
    const presence = new CatPresence({ missLimit, onChange: (present) => changes.push(present) });
    return { changes, presence };
}

test('a cat sets presence and emits one change', () => {
    const { changes, presence } = build();

    presence.recordDetection(true);
    presence.recordDetection(true);

    assert.equal(presence.present, true);
    assert.deepEqual(changes, [true]);
});

test('presence survives fewer misses than the limit', () => {
    const { presence } = build();

    presence.recordDetection(true);
    presence.recordDetection(false);
    presence.recordDetection(false);

    assert.equal(presence.present, true);
});

test('the miss limit clears presence', () => {
    const { changes, presence } = build();

    presence.recordDetection(true);
    presence.recordDetection(false);
    presence.recordDetection(false);
    presence.recordDetection(false);

    assert.equal(presence.present, false);
    assert.deepEqual(changes, [true, false]);
});

test('a cat resets the miss counter', () => {
    const { presence } = build();

    presence.recordDetection(true);
    presence.recordDetection(false);
    presence.recordDetection(false);
    presence.recordDetection(true);
    presence.recordDetection(false);
    presence.recordDetection(false);

    assert.equal(presence.present, true);
});

test('misses while already absent emit nothing', () => {
    const { changes, presence } = build();

    presence.recordDetection(false);
    presence.recordDetection(false);
    presence.recordDetection(false);
    presence.recordDetection(false);

    assert.deepEqual(changes, []);
});

test('reset clears presence and the miss counter', () => {
    const { changes, presence } = build();

    presence.recordDetection(true);
    presence.reset();
    presence.recordDetection(false);
    presence.recordDetection(false);

    assert.equal(presence.present, false);
    assert.deepEqual(changes, [true, false]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd roles/doorbell && yarn test`
Expected: FAIL — cannot find `./presence.js`.

- [ ] **Step 3: Write the implementation**

`roles/doorbell/src/presence.ts`:

```typescript
/**
 * Latches cat presence across event-driven samples. A single positive frame sets
 * it; it takes `missLimit` consecutive evaluated frames without a cat to clear it.
 *
 * Only evaluated frames belong here. A failed frame grab or a failed inference is
 * an absence of evidence, not evidence of absence, and must not be recorded.
 */
export class CatPresence {
    readonly #missLimit: number;
    readonly #onChange: (present: boolean) => void;

    #misses = 0;
    #present = false;

    constructor(options: { missLimit: number; onChange: (present: boolean) => void }) {
        this.#missLimit = options.missLimit;
        this.#onChange = options.onChange;
    }

    get present(): boolean {
        return this.#present;
    }

    recordDetection(hasCat: boolean): void {
        if (hasCat) {
            this.#misses = 0;
            this.#set(true);
            return;
        }

        this.#misses += 1;
        if (this.#misses >= this.#missLimit) this.#set(false);
    }

    reset(): void {
        this.#misses = 0;
        this.#set(false);
    }

    #set(present: boolean): void {
        if (this.#present === present) return;
        this.#present = present;
        this.#onChange(present);
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd roles/doorbell && yarn test`
Expected: PASS, 25 tests total.

- [ ] **Step 5: Commit**

```bash
git add roles/doorbell/src
git commit -m "Add cat presence latch"
```

---

### Task 5: Bounded serial queue

**Files:**
- Create: `roles/doorbell/src/queue.ts`
- Test: `roles/doorbell/src/queue.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class SerialQueue<T>` with `push(item: T): void`, `get size(): number`, `drain(): Promise<void>`, constructed as `new SerialQueue<T>({ max, worker, onEvict?, onError? })`.

- [ ] **Step 1: Write the failing test**

`roles/doorbell/src/queue.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SerialQueue } from './queue.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('processes items in order', async () => {
    const processed: number[] = [];
    const queue = new SerialQueue<number>({
        max: 10,
        worker: async (item) => { processed.push(item); },
    });

    queue.push(1);
    queue.push(2);
    queue.push(3);
    await queue.drain();

    assert.deepEqual(processed, [1, 2, 3]);
});

test('never runs two workers at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const queue = new SerialQueue<number>({
        max: 10,
        worker: async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await tick();
            inFlight -= 1;
        },
    });

    queue.push(1);
    queue.push(2);
    queue.push(3);
    await queue.drain();

    assert.equal(maxInFlight, 1);
});

test('evicts the oldest item when full', async () => {
    const evicted: number[] = [];
    const processed: number[] = [];
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const queue = new SerialQueue<number>({
        max: 2,
        onEvict: (item) => evicted.push(item),
        worker: async (item) => {
            processed.push(item);
            if (item === 1) await blocked;
        },
    });

    queue.push(1);
    await tick();
    queue.push(2);
    queue.push(3);
    queue.push(4);

    assert.deepEqual(evicted, [2]);

    release();
    await queue.drain();

    assert.deepEqual(processed, [1, 3, 4]);
});

test('a worker error does not stop the queue', async () => {
    const errors: string[] = [];
    const processed: number[] = [];
    const queue = new SerialQueue<number>({
        max: 10,
        onError: (error) => errors.push(String(error)),
        worker: async (item) => {
            if (item === 2) throw new Error('boom');
            processed.push(item);
        },
    });

    queue.push(1);
    queue.push(2);
    queue.push(3);
    await queue.drain();

    assert.deepEqual(processed, [1, 3]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /boom/);
});

test('size reports items still waiting, not the one in flight', async () => {
    const queue = new SerialQueue<number>({ max: 10, worker: async () => { await tick(); } });

    queue.push(1);
    queue.push(2);
    queue.push(3);

    // push() starts the pump synchronously, so item 1 has already been shifted
    // out and is in flight; 2 and 3 are waiting.
    assert.equal(queue.size, 2);
    await queue.drain();
    assert.equal(queue.size, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd roles/doorbell && yarn test`
Expected: FAIL — cannot find `./queue.js`.

- [ ] **Step 3: Write the implementation**

`roles/doorbell/src/queue.ts`:

```typescript
export interface SerialQueueOptions<T> {
    max: number;
    worker: (item: T) => Promise<void>;
    onEvict?: (item: T) => void;
    onError?: (error: unknown, item: T) => void;
}

/**
 * A bounded FIFO worked one item at a time. When full, the oldest item is dropped
 * rather than the newest: a stale frame is worth less than a fresh one.
 */
export class SerialQueue<T> {
    readonly #options: SerialQueueOptions<T>;
    readonly #items: T[] = [];
    #running = false;

    constructor(options: SerialQueueOptions<T>) {
        this.#options = options;
    }

    get size(): number {
        return this.#items.length;
    }

    push(item: T): void {
        if (this.#items.length >= this.#options.max) {
            const evicted = this.#items.shift() as T;
            this.#options.onEvict?.(evicted);
        }
        this.#items.push(item);
        void this.#pump();
    }

    async drain(): Promise<void> {
        while (this.#running || this.#items.length > 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    }

    async #pump(): Promise<void> {
        if (this.#running) return;
        this.#running = true;

        try {
            while (this.#items.length > 0) {
                const item = this.#items.shift() as T;
                try {
                    await this.#options.worker(item);
                } catch (error) {
                    this.#options.onError?.(error, item);
                }
            }
        } finally {
            this.#running = false;
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd roles/doorbell && yarn test`
Expected: PASS, 30 tests total.

- [ ] **Step 5: Commit**

```bash
git add roles/doorbell/src
git commit -m "Add bounded serial queue"
```

---

### Task 6: Vision client

**Files:**
- Create: `roles/doorbell/src/vision.ts`
- Test: `roles/doorbell/src/vision.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PROMPT`, `detectionsSchema`, `type Detection`, `interface Box { xMin, yMin, xMax, yMax }`, `scaleBox(bbox, width, height): Box`, `hasCat(detections): boolean`, `interface VisionClient { detect(imagePath: string): Promise<Detection[]> }`, `createVisionClient({ baseUrl, model }): VisionClient`.

**Background (verified against `@lmstudio/sdk@1.5.0`):** `new LMStudioClient({ baseUrl })` takes a `ws://` URL. `client.files.prepareImage(path)` returns a `FileHandle`. A chat message may carry `images: FileHandle[]`. `model.respond(chat, { structured: zodSchema })` returns a result whose `.parsed` is typed by the schema.

- [ ] **Step 1: Write the failing test**

`roles/doorbell/src/vision.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectionsSchema, hasCat, scaleBox } from './vision.js';

test('scales a full-frame box', () => {
    assert.deepEqual(scaleBox([0, 0, 1000, 1000], 512, 384), { xMin: 0, yMin: 0, xMax: 511, yMax: 383 });
});

test('scales a half-frame box', () => {
    assert.deepEqual(scaleBox([0, 0, 500, 500], 512, 384), { xMin: 0, yMin: 0, xMax: 256, yMax: 192 });
});

test('clamps coordinates beyond the 0-1000 scale', () => {
    assert.deepEqual(scaleBox([-50, -50, 1200, 1200], 512, 384), { xMin: 0, yMin: 0, xMax: 511, yMax: 383 });
});

test('normalises an inverted box', () => {
    const box = scaleBox([800, 800, 200, 200], 1000, 1000);

    assert.equal(box.xMin, 200);
    assert.equal(box.xMax, 800);
    assert.equal(box.yMin, 200);
    assert.equal(box.yMax, 800);
});

test('hasCat is true for any cat label regardless of case', () => {
    assert.equal(hasCat([{ label: 'Cat', bbox_2d: [0, 0, 1, 1] }]), true);
    assert.equal(hasCat([{ label: 'cat', bbox_2d: [0, 0, 1, 1] }]), true);
});

test('hasCat is false for an empty list', () => {
    assert.equal(hasCat([]), false);
});

test('hasCat is false when nothing is a cat', () => {
    assert.equal(hasCat([{ label: 'dog', bbox_2d: [0, 0, 1, 1] }]), false);
});

test('the schema accepts a well-formed response', () => {
    const parsed = detectionsSchema.parse([{ label: 'cat', bbox_2d: [10, 20, 30, 40] }]);

    assert.equal(parsed[0].label, 'cat');
    assert.deepEqual(parsed[0].bbox_2d, [10, 20, 30, 40]);
});

test('the schema rejects a short bbox', () => {
    assert.throws(() => detectionsSchema.parse([{ label: 'cat', bbox_2d: [10, 20, 30] }]));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd roles/doorbell && yarn test`
Expected: FAIL — cannot find `./vision.js`.

- [ ] **Step 3: Write the implementation**

`roles/doorbell/src/vision.ts`:

```typescript
import { LMStudioClient } from '@lmstudio/sdk';
import { z } from 'zod';

export const PROMPT =
    "Provide the bounding box coordinates for detect all cats. Report strictly in JSON format as a list of objects with 'label' and 'bbox_2d' (xmin, ymin, xmax, ymax in 0-1000 scale). If there are not cats, return empty list.";

export const detectionsSchema = z.array(
    z.object({
        label: z.string(),
        bbox_2d: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    }),
);

export type Detection = z.infer<typeof detectionsSchema>[number];

export interface Box {
    xMin: number;
    yMin: number;
    xMax: number;
    yMax: number;
}

/** Convert gemma's 0-1000 normalised coordinates to pixels within the frame. */
export function scaleBox(bbox: [number, number, number, number], width: number, height: number): Box {
    const clamp = (value: number, size: number) => Math.min(Math.max(Math.round(value), 0), size - 1);
    const [rawXMin, rawYMin, rawXMax, rawYMax] = bbox;

    const x1 = clamp((rawXMin / 1000) * width, width);
    const x2 = clamp((rawXMax / 1000) * width, width);
    const y1 = clamp((rawYMin / 1000) * height, height);
    const y2 = clamp((rawYMax / 1000) * height, height);

    return {
        xMin: Math.min(x1, x2),
        yMin: Math.min(y1, y2),
        xMax: Math.max(x1, x2),
        yMax: Math.max(y1, y2),
    };
}

export function hasCat(detections: Detection[]): boolean {
    return detections.some((detection) => detection.label.toLowerCase().includes('cat'));
}

export interface VisionClient {
    detect(imagePath: string): Promise<Detection[]>;
}

export function createVisionClient(options: { baseUrl: string; model: string }): VisionClient {
    const client = new LMStudioClient({ baseUrl: options.baseUrl });
    let model: Awaited<ReturnType<typeof client.llm.model>> | null = null;

    return {
        async detect(imagePath: string): Promise<Detection[]> {
            model ??= await client.llm.model(options.model);
            const image = await client.files.prepareImage(imagePath);

            const result = await model.respond(
                [{ role: 'user', content: PROMPT, images: [image] }],
                { structured: detectionsSchema, temperature: 0 },
            );

            return result.parsed;
        },
    };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd roles/doorbell && yarn test`
Expected: PASS, 39 tests total.

- [ ] **Step 5: Commit**

```bash
git add roles/doorbell/src
git commit -m "Add LM Studio vision client"
```

---

### Task 7: Frame annotation and storage

**Files:**
- Create: `roles/doorbell/src/annotate.ts`
- Test: `roles/doorbell/src/annotate.test.ts`

**Interfaces:**
- Consumes: `Box`, `Detection`, `scaleBox` from `vision.ts`.
- Produces: `rawFramePath(framesPath, at): string`, `resultPaths(framesPath, at, verdict): { annotated, json }`, `drawBoxes(image, boxes): void`, `annotate(raw, detections): Promise<{ buffer, boxes }>`, `writeResult(options): Promise<void>`, `type Verdict = 'cat' | 'nocat'`.

**Background (verified against `jimp@1.6.1`):** `await Jimp.fromBuffer(buffer)` yields an image with `.width`, `.height`, `.setPixelColor(hex, x, y)` and `await image.getBuffer('image/jpeg', { quality })`. `new Jimp({ width, height, color })` creates a blank image, which the test uses to build a JPEG without a fixture file. Colours are RGBA hex.

- [ ] **Step 1: Write the failing test**

`roles/doorbell/src/annotate.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { annotate, drawBoxes, rawFramePath, resultPaths, writeResult } from './annotate.js';

// Tests run under TZ=America/Los_Angeles, so local components are deterministic.
const AT = new Date(2026, 8, 11, 14, 5, 9);

test('raw frame path is dated and timed', () => {
    assert.equal(rawFramePath('/frames', AT), '/frames/2026-09-11/140509.raw.jpg');
});

test('result paths carry the verdict on the annotated image only', () => {
    assert.deepEqual(resultPaths('/frames', AT, 'cat'), {
        annotated: '/frames/2026-09-11/140509-cat.jpg',
        json: '/frames/2026-09-11/140509.json',
    });
    assert.equal(resultPaths('/frames', AT, 'nocat').annotated, '/frames/2026-09-11/140509-nocat.jpg');
});

test('drawBoxes paints the four edges and nothing inside', () => {
    const painted = new Set<string>();
    const image = {
        width: 100,
        height: 100,
        setPixelColor: (_hex: number, x: number, y: number) => { painted.add(`${x},${y}`); },
    };

    drawBoxes(image, [{ xMin: 10, yMin: 10, xMax: 20, yMax: 20 }]);

    assert.ok(painted.has('10,10'));
    assert.ok(painted.has('20,20'));
    assert.ok(painted.has('15,10'));
    assert.ok(painted.has('10,15'));
    assert.ok(!painted.has('15,15'));
});

test('drawBoxes stays inside the image for an edge box', () => {
    const image = {
        width: 10,
        height: 10,
        setPixelColor: (_hex: number, x: number, y: number) => {
            assert.ok(x >= 0 && x < 10, `x out of bounds: ${x}`);
            assert.ok(y >= 0 && y < 10, `y out of bounds: ${y}`);
        },
    };

    drawBoxes(image, [{ xMin: 0, yMin: 0, xMax: 9, yMax: 9 }]);
});

test('annotate scales detections against the real frame size and returns a jpeg', async () => {
    const blank = new Jimp({ width: 100, height: 100, color: 0x000000ff });
    const raw = await blank.getBuffer('image/jpeg', { quality: 90 });

    const { buffer, boxes } = await annotate(raw, [{ label: 'cat', bbox_2d: [0, 0, 500, 500] }]);

    assert.deepEqual(boxes, [{ xMin: 0, yMin: 0, xMax: 50, yMax: 50 }]);
    assert.equal(buffer[0], 0xff);
    assert.equal(buffer[1], 0xd8);
});

test('writeResult creates the day directory and both files', async () => {
    const framesPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'doorbell-'));

    await writeResult({
        framesPath,
        at: AT,
        verdict: 'cat',
        annotated: Buffer.from([0xff, 0xd8]),
        body: { detections: [] },
    });

    assert.ok(fs.existsSync(path.join(framesPath, '2026-09-11', '140509-cat.jpg')));
    const json = await fs.promises.readFile(path.join(framesPath, '2026-09-11', '140509.json'), 'utf-8');
    assert.deepEqual(JSON.parse(json), { detections: [] });
});

test('writeResult with no annotated image still writes the json', async () => {
    const framesPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'doorbell-'));

    await writeResult({
        framesPath,
        at: AT,
        verdict: 'nocat',
        annotated: null,
        body: { error: 'lm studio unreachable' },
    });

    assert.ok(!fs.existsSync(path.join(framesPath, '2026-09-11', '140509-nocat.jpg')));
    assert.ok(fs.existsSync(path.join(framesPath, '2026-09-11', '140509.json')));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd roles/doorbell && yarn test`
Expected: FAIL — cannot find `./annotate.js`.

- [ ] **Step 3: Write the implementation**

`roles/doorbell/src/annotate.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { Jimp } from 'jimp';
import { Box, Detection, scaleBox } from './vision.js';

const BOX_COLOR = 0xff0000ff; // opaque red, RGBA
const BOX_THICKNESS = 2;

export type Verdict = 'cat' | 'nocat';

/** Minimal surface of a Jimp image, so drawing can be tested without decoding one. */
export interface DrawableImage {
    width: number;
    height: number;
    setPixelColor(hex: number, x: number, y: number): unknown;
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

function frameDay(at: Date): string {
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function frameTime(at: Date): string {
    return `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

export function rawFramePath(framesPath: string, at: Date): string {
    return path.join(framesPath, frameDay(at), `${frameTime(at)}.raw.jpg`);
}

export function resultPaths(framesPath: string, at: Date, verdict: Verdict): { annotated: string; json: string } {
    const dir = path.join(framesPath, frameDay(at));
    return {
        annotated: path.join(dir, `${frameTime(at)}-${verdict}.jpg`),
        json: path.join(dir, `${frameTime(at)}.json`),
    };
}

export function drawBoxes(image: DrawableImage, boxes: Box[]): void {
    for (const box of boxes) {
        for (let thickness = 0; thickness < BOX_THICKNESS; thickness += 1) {
            const top = Math.min(box.yMin + thickness, image.height - 1);
            const bottom = Math.max(box.yMax - thickness, 0);
            const left = Math.min(box.xMin + thickness, image.width - 1);
            const right = Math.max(box.xMax - thickness, 0);

            for (let x = box.xMin; x <= box.xMax; x += 1) {
                image.setPixelColor(BOX_COLOR, x, top);
                image.setPixelColor(BOX_COLOR, x, bottom);
            }
            for (let y = box.yMin; y <= box.yMax; y += 1) {
                image.setPixelColor(BOX_COLOR, left, y);
                image.setPixelColor(BOX_COLOR, right, y);
            }
        }
    }
}

/** Decode once: the frame's real size is what the 0-1000 coordinates scale against. */
export async function annotate(raw: Buffer, detections: Detection[]): Promise<{ buffer: Buffer; boxes: Box[] }> {
    const image = await Jimp.fromBuffer(raw);
    const boxes = detections.map((detection) => scaleBox(detection.bbox_2d, image.width, image.height));

    drawBoxes(image, boxes);

    return { buffer: await image.getBuffer('image/jpeg', { quality: 90 }), boxes };
}

export async function writeResult(options: {
    framesPath: string;
    at: Date;
    verdict: Verdict;
    annotated: Buffer | null;
    body: unknown;
}): Promise<void> {
    const paths = resultPaths(options.framesPath, options.at, options.verdict);

    await fs.promises.mkdir(path.dirname(paths.json), { recursive: true });
    if (options.annotated) await fs.promises.writeFile(paths.annotated, options.annotated);
    await fs.promises.writeFile(paths.json, `${JSON.stringify(options.body, null, 2)}\n`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd roles/doorbell && yarn test`
Expected: PASS, 46 tests total.

- [ ] **Step 5: Commit**

```bash
git add roles/doorbell/src
git commit -m "Add frame annotation and storage"
```

---

### Task 8: go2rtc frame grab

**Files:**
- Create: `roles/doorbell/src/frames.ts`
- Test: `roles/doorbell/src/frames.test.ts`

**Interfaces:**
- Consumes: `rawFramePath` from `annotate.ts`.
- Produces: `interface Frame { at: Date; raw: Buffer; rawPath: string }`, `frameUrl(go2rtcUrl, stream): string`, `grabFrame(options): Promise<Frame>`.

- [ ] **Step 1: Write the failing test**

`roles/doorbell/src/frames.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frameUrl, grabFrame } from './frames.js';

const AT = new Date(2026, 8, 11, 14, 5, 9);

async function framesDir(): Promise<string> {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), 'doorbell-'));
}

test('builds the go2rtc frame url', () => {
    assert.equal(frameUrl('http://go2rtc:1984', 'front_door'), 'http://go2rtc:1984/api/frame.jpeg?src=front_door');
});

test('tolerates a trailing slash on the base url', () => {
    assert.equal(frameUrl('http://go2rtc:1984/', 'front_door'), 'http://go2rtc:1984/api/frame.jpeg?src=front_door');
});

test('writes the raw frame to a dated path', async () => {
    const framesPath = await framesDir();

    const frame = await grabFrame({
        go2rtcUrl: 'http://go2rtc:1984',
        stream: 'front_door',
        framesPath,
        at: AT,
        fetchImpl: async () => Buffer.from([0xff, 0xd8, 0x01]),
    });

    assert.equal(frame.rawPath, path.join(framesPath, '2026-09-11', '140509.raw.jpg'));
    assert.deepEqual(await fs.promises.readFile(frame.rawPath), Buffer.from([0xff, 0xd8, 0x01]));
});

test('retries once after a failure', async () => {
    const framesPath = await framesDir();
    let attempts = 0;
    const delays: number[] = [];

    const frame = await grabFrame({
        go2rtcUrl: 'http://go2rtc:1984',
        stream: 'front_door',
        framesPath,
        at: AT,
        delay: async (ms) => { delays.push(ms); },
        fetchImpl: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('connection refused');
            return Buffer.from([0xff, 0xd8]);
        },
    });

    assert.equal(attempts, 2);
    assert.deepEqual(delays, [3000]);
    assert.equal(frame.raw.length, 2);
});

test('gives up after the retry also fails', async () => {
    const framesPath = await framesDir();
    let attempts = 0;

    await assert.rejects(
        grabFrame({
            go2rtcUrl: 'http://go2rtc:1984',
            stream: 'front_door',
            framesPath,
            at: AT,
            delay: async () => {},
            fetchImpl: async () => { attempts += 1; throw new Error('connection refused'); },
        }),
        /connection refused/,
    );

    assert.equal(attempts, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd roles/doorbell && yarn test`
Expected: FAIL — cannot find `./frames.js`.

- [ ] **Step 3: Write the implementation**

`roles/doorbell/src/frames.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { rawFramePath } from './annotate.js';

const GRAB_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 3_000;

export interface Frame {
    at: Date;
    raw: Buffer;
    rawPath: string;
}

export function frameUrl(go2rtcUrl: string, stream: string): string {
    return `${go2rtcUrl.replace(/\/$/, '')}/api/frame.jpeg?src=${encodeURIComponent(stream)}`;
}

async function fetchFrame(url: string): Promise<Buffer> {
    const response = await fetch(url, { signal: AbortSignal.timeout(GRAB_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`go2rtc returned ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

/**
 * Grab one frame and persist it. The first grab after a window opens can fail
 * while go2rtc is still dialling Nest, so one retry is worth it; beyond that the
 * next tick is only 30s away.
 */
export async function grabFrame(options: {
    go2rtcUrl: string;
    stream: string;
    framesPath: string;
    at?: Date;
    fetchImpl?: (url: string) => Promise<Buffer>;
    delay?: (ms: number) => Promise<void>;
}): Promise<Frame> {
    const at = options.at ?? new Date();
    const grab = options.fetchImpl ?? fetchFrame;
    const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const url = frameUrl(options.go2rtcUrl, options.stream);

    let raw: Buffer;
    try {
        raw = await grab(url);
    } catch (error) {
        console.warn(`frame grab failed, retrying in ${RETRY_DELAY_MS}ms`, error);
        await delay(RETRY_DELAY_MS);
        raw = await grab(url);
    }

    const rawPath = rawFramePath(options.framesPath, at);
    await fs.promises.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.promises.writeFile(rawPath, raw);

    return { at, raw, rawPath };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd roles/doorbell && yarn test`
Expected: PASS, 51 tests total.

- [ ] **Step 5: Commit**

```bash
git add roles/doorbell/src
git commit -m "Add go2rtc frame grab"
```

---

### Task 9: MQTT client and Home Assistant discovery

**Files:**
- Create: `roles/doorbell/src/mqtt.ts`
- Test: `roles/doorbell/src/mqtt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `topics(camera): Topics`, `discoveryPayloads(camera): Array<{ topic: string; payload: Record<string, unknown> }>`, `interface DoorbellMqtt`, `connectMqtt({ url, camera }): Promise<DoorbellMqtt>`.

**Design note:** `setWindowOpen(open)` publishes *both* the activity state and the Frigate command, so the two cannot drift apart. The reconcile that runs on connect and on every reconnect republishes discovery plus the current window and cat state — which at boot is `false`/`false`, and therefore is exactly the "everything off" recovery the spec requires.

- [ ] **Step 1: Write the failing test**

`roles/doorbell/src/mqtt.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryPayloads, topics } from './mqtt.js';

test('topics derive the frigate command from the camera name', () => {
    assert.equal(topics('front_door').frigateCommand, 'frigate/front_door/enabled/set');
    assert.equal(topics('side_gate').frigateCommand, 'frigate/side_gate/enabled/set');
});

test('topics are stable', () => {
    assert.deepEqual(topics('front_door'), {
        availability: 'doorbell/availability',
        cat: 'doorbell/cat/state',
        activity: 'doorbell/activity/state',
        image: 'doorbell/detection/image',
        lastDetection: 'doorbell/detection/last/state',
        frigateCommand: 'frigate/front_door/enabled/set',
    });
});

test('publishes four discovery configs on homeassistant topics', () => {
    const payloads = discoveryPayloads('front_door');

    assert.deepEqual(payloads.map((entry) => entry.topic), [
        'homeassistant/binary_sensor/doorbell/cat/config',
        'homeassistant/binary_sensor/doorbell/activity/config',
        'homeassistant/image/doorbell/detection/config',
        'homeassistant/sensor/doorbell/last_detection/config',
    ]);
});

test('every entity has a unique id, availability, and the shared device', () => {
    const uniqueIds = new Set<string>();

    for (const { payload } of discoveryPayloads('front_door')) {
        assert.equal(payload.availability_topic, 'doorbell/availability');
        assert.deepEqual((payload.device as { identifiers: string[] }).identifiers, ['doorbell']);
        uniqueIds.add(payload.unique_id as string);
    }

    assert.equal(uniqueIds.size, 4);
});

test('the cat sensor is an occupancy binary sensor on the cat topic', () => {
    const { payload } = discoveryPayloads('front_door')[0];

    assert.equal(payload.device_class, 'occupancy');
    assert.equal(payload.state_topic, 'doorbell/cat/state');
    assert.equal(payload.payload_on, 'ON');
    assert.equal(payload.payload_off, 'OFF');
});

test('the activity sensor uses the running device class', () => {
    const { payload } = discoveryPayloads('front_door')[1];

    assert.equal(payload.device_class, 'running');
    assert.equal(payload.state_topic, 'doorbell/activity/state');
});

test('the image entity points at the image topic', () => {
    const { payload } = discoveryPayloads('front_door')[2];

    assert.equal(payload.image_topic, 'doorbell/detection/image');
    assert.equal(payload.content_type, 'image/jpeg');
});

test('the last detection sensor is a timestamp', () => {
    const { payload } = discoveryPayloads('front_door')[3];

    assert.equal(payload.device_class, 'timestamp');
    assert.equal(payload.state_topic, 'doorbell/detection/last/state');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd roles/doorbell && yarn test`
Expected: FAIL — cannot find `./mqtt.js`.

- [ ] **Step 3: Write the implementation**

`roles/doorbell/src/mqtt.ts`:

```typescript
import mqtt, { MqttClient } from 'mqtt';

export interface Topics {
    availability: string;
    cat: string;
    activity: string;
    image: string;
    lastDetection: string;
    frigateCommand: string;
}

export function topics(camera: string): Topics {
    return {
        availability: 'doorbell/availability',
        cat: 'doorbell/cat/state',
        activity: 'doorbell/activity/state',
        image: 'doorbell/detection/image',
        lastDetection: 'doorbell/detection/last/state',
        frigateCommand: `frigate/${camera}/enabled/set`,
    };
}

const DEVICE = {
    identifiers: ['doorbell'],
    name: 'Doorbell',
    manufacturer: 'home',
    model: 'doorbell vision',
};

export function discoveryPayloads(camera: string): Array<{ topic: string; payload: Record<string, unknown> }> {
    const topic = topics(camera);
    const base = { availability_topic: topic.availability, device: DEVICE };

    return [
        {
            topic: 'homeassistant/binary_sensor/doorbell/cat/config',
            payload: {
                ...base,
                name: 'Cat',
                unique_id: 'doorbell_cat',
                device_class: 'occupancy',
                state_topic: topic.cat,
                payload_on: 'ON',
                payload_off: 'OFF',
            },
        },
        {
            topic: 'homeassistant/binary_sensor/doorbell/activity/config',
            payload: {
                ...base,
                name: 'Activity',
                unique_id: 'doorbell_activity',
                device_class: 'running',
                state_topic: topic.activity,
                payload_on: 'ON',
                payload_off: 'OFF',
            },
        },
        {
            topic: 'homeassistant/image/doorbell/detection/config',
            payload: {
                ...base,
                name: 'Detection',
                unique_id: 'doorbell_detection',
                image_topic: topic.image,
                content_type: 'image/jpeg',
            },
        },
        {
            topic: 'homeassistant/sensor/doorbell/last_detection/config',
            payload: {
                ...base,
                name: 'Last detection',
                unique_id: 'doorbell_last_detection',
                device_class: 'timestamp',
                state_topic: topic.lastDetection,
            },
        },
    ];
}

export interface DoorbellMqtt {
    /** Publishes both the activity state and the Frigate enable command. */
    setWindowOpen(open: boolean): void;
    setCatPresent(present: boolean): void;
    publishDetection(image: Buffer, at: Date): void;
    end(): Promise<void>;
}

export async function connectMqtt(options: { url: string; camera: string }): Promise<DoorbellMqtt> {
    const topic = topics(options.camera);
    const state = { windowOpen: false, catPresent: false };

    const client: MqttClient = await mqtt.connectAsync(options.url, {
        clientId: `doorbell-${process.pid}`,
        will: { topic: topic.availability, payload: Buffer.from('offline'), qos: 1, retain: true },
    });

    const publish = (target: string, payload: string | Buffer, retain = true): void => {
        client.publish(target, payload, { qos: 1, retain });
    };

    const onOff = (value: boolean): string => (value ? 'ON' : 'OFF');

    const reconcile = (): void => {
        for (const entry of discoveryPayloads(options.camera)) {
            publish(entry.topic, JSON.stringify(entry.payload));
        }
        publish(topic.availability, 'online');
        publish(topic.activity, onOff(state.windowOpen));
        publish(topic.cat, onOff(state.catPresent));
        // Commands are never retained: a retained command replays itself at every
        // broker or Frigate restart.
        publish(topic.frigateCommand, onOff(state.windowOpen), false);
    };

    // connectAsync resolves after the first connect, so reconcile once here and
    // again on every reconnect.
    reconcile();
    client.on('connect', () => {
        console.log('mqtt reconnected');
        reconcile();
    });

    return {
        setWindowOpen(open: boolean): void {
            state.windowOpen = open;
            publish(topic.activity, onOff(open));
            publish(topic.frigateCommand, onOff(open), false);
        },

        setCatPresent(present: boolean): void {
            state.catPresent = present;
            publish(topic.cat, onOff(present));
        },

        publishDetection(image: Buffer, at: Date): void {
            publish(topic.image, image);
            publish(topic.lastDetection, at.toISOString());
        },

        async end(): Promise<void> {
            await client.publishAsync(topic.availability, 'offline', { qos: 1, retain: true });
            await client.endAsync();
        },
    };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd roles/doorbell && yarn test`
Expected: PASS, 59 tests total.

- [ ] **Step 5: Commit**

```bash
git add roles/doorbell/src
git commit -m "Add MQTT client and Home Assistant discovery"
```

---

### Task 10: Wire the service together

**Files:**
- Create: `roles/doorbell/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-9.
- Produces: the container entrypoint. Nothing imports it.

**Note:** there is no unit test for this file — it is wiring, and every piece it wires is already covered. It is verified by the deploy checks in Task 12.

- [ ] **Step 1: Write the implementation**

`roles/doorbell/src/index.ts`:

```typescript
import { loadConfig } from './config.js';
import { subscribeToDoorbellEvents } from './events.js';
import { ActivityWindow } from './window.js';
import { CatPresence } from './presence.js';
import { SerialQueue } from './queue.js';
import { createVisionClient, hasCat } from './vision.js';
import { Frame, grabFrame } from './frames.js';
import { annotate, writeResult } from './annotate.js';
import { connectMqtt } from './mqtt.js';

const config = loadConfig();

const broker = await connectMqtt({ url: config.mqttUrl, camera: config.frigateCamera });
const vision = createVisionClient({ baseUrl: config.lmStudioUrl, model: config.lmStudioModel });

const presence = new CatPresence({
    missLimit: config.missLimit,
    onChange: (present) => {
        console.log(`cat ${present ? 'present' : 'absent'}`);
        broker.setCatPresent(present);
    },
});

const queue = new SerialQueue<Frame>({
    max: config.queueMax,
    onEvict: (frame) => console.warn(`evicted ${frame.rawPath}, queue is backed up`),
    onError: (error, frame) => console.error(`failed to process ${frame.rawPath}`, error),
    worker: async (frame) => {
        let detections;
        try {
            detections = await vision.detect(frame.rawPath);
        } catch (error) {
            // An inference failure says nothing about the cat, so the miss counter
            // is deliberately left alone.
            await writeResult({
                framesPath: config.framesPath,
                at: frame.at,
                verdict: 'nocat',
                annotated: null,
                body: { error: String(error) },
            });
            throw error;
        }

        const { buffer, boxes } = await annotate(frame.raw, detections);
        const cat = hasCat(detections);

        await writeResult({
            framesPath: config.framesPath,
            at: frame.at,
            verdict: cat ? 'cat' : 'nocat',
            annotated: buffer,
            body: { detections, boxes },
        });

        broker.publishDetection(buffer, frame.at);
        presence.recordDetection(cat);
    },
});

async function tick(): Promise<void> {
    try {
        queue.push(await grabFrame({
            go2rtcUrl: config.go2rtcUrl,
            stream: config.go2rtcStream,
            framesPath: config.framesPath,
        }));
    } catch (error) {
        // Same reasoning as an inference failure: no frame, no evidence.
        console.error('frame grab failed', error);
    }
}

const activityWindow = new ActivityWindow({
    windowMs: config.windowMs,
    pollMs: config.pollMs,
    callbacks: {
        onOpen: () => {
            console.log('window open');
            broker.setWindowOpen(true);
        },
        onTick: () => { void tick(); },
        onClose: () => {
            console.log('window closed');
            broker.setWindowOpen(false);
            presence.reset();
            // reset() only emits on a transition; publish unconditionally so the
            // retained topic is OFF whatever the latch thought.
            broker.setCatPresent(false);
        },
    },
});

const subscription = subscribeToDoorbellEvents({
    subscription: config.pubsubSubscription,
    credentials: config.googleCredentials,
    deviceId: config.nestDeviceId,
    onEvent: () => activityWindow.onEvent(),
    onFatal: (error) => {
        console.error('pubsub subscription failed', error);
        void shutdown(1);
    },
});

console.log(`subscribed to ${config.pubsubSubscription}`);

let shuttingDown = false;

async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('shutting down');
    activityWindow.close();

    try {
        await subscription.close();
        await queue.drain();
        await broker.end();
    } catch (error) {
        console.error('shutdown failed', error);
    }

    process.exit(code);
}

process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));
```

- [ ] **Step 2: Verify it compiles and the suite still passes**

Run: `cd roles/doorbell && yarn test`
Expected: PASS, 59 tests, no TypeScript errors.

- [ ] **Step 3: Verify the image builds**

Run: `cd roles/doorbell && docker build --platform linux/amd64 -t doorbell-build-check .`
Expected: builds through `yarn run build`. This is the check that `--frozen-lockfile` is satisfied by the committed `yarn.lock` — the failure mode the jimp-over-sharp choice exists to avoid.

- [ ] **Step 4: Commit**

```bash
git add roles/doorbell/src
git commit -m "Wire the doorbell service together"
```

---

### Task 11: Ansible role and repo wiring

**Files:**
- Create: `roles/doorbell/defaults/main.yml`, `roles/doorbell/tasks/main.yml`, `roles/doorbell/README.md`
- Modify: `playbook.yml` (the `deploy` play's role list), `README.md` (the roles list)

**Interfaces:**
- Consumes: the container entrypoint from Task 10.
- Produces: the `doorbell` Swarm stack.

**Prerequisite, not created by this task:** `config.doorbell.google_credentials` must exist in the sops `env` submodule, holding the service account JSON. The deploy fails with an undefined-variable error if it is missing.

- [ ] **Step 1: Write the defaults**

`roles/doorbell/defaults/main.yml`:

```yaml
---

doorbell_pubsub_subscription: <redacted>
doorbell_nest_device_id: <redacted>
doorbell_go2rtc_url: http://go2rtc:1984
doorbell_go2rtc_stream: front_door
doorbell_lm_studio_url: <redacted>
doorbell_lm_studio_model: gemma-3-12b-it-qat
doorbell_mqtt_url: mqtt://mosquitto:1883
doorbell_frigate_camera: front_door
doorbell_window_ms: 120000
doorbell_poll_ms: 30000
doorbell_miss_limit: 3
doorbell_queue_max: 4
```

- [ ] **Step 2: Write the role tasks**

`roles/doorbell/tasks/main.yml`:

```yaml
---

- name: create directories
  ansible.builtin.file:
    path: /mnt/gluster/doorbell/frames
    owner: pi
    group: pi
    state: directory

- name: build
  community.docker.docker_image_build:
    name: "gitea.{{ config.domain }}/{{ config.gitea.username }}/doorbell"
    tag: latest
    path: "{{ role_path }}"
    rebuild: always
    platform:
      - linux/amd64
    outputs:
      - type: image
        push: true
  delegate_to: localhost
  register: build_result

- name: deploy stack
  community.general.docker_stack:
    name: doorbell
    prune: yes
    resolve_image: always
    compose:
      - version: '3.8'
        services:
          doorbell:
            image: "{{ build_result.image.RepoDigests[0] }}"
            networks:
              - go2rtc_go2rtc
              - mosquitto_mosquitto
            volumes:
              - /mnt/gluster/doorbell/frames:/frames
            environment:
              TZ: America/Los_Angeles
              GOOGLE_CREDENTIALS_JSON: "{{ config.doorbell.google_credentials | to_json }}"
              PUBSUB_SUBSCRIPTION: "{{ doorbell_pubsub_subscription }}"
              NEST_DEVICE_ID: "{{ doorbell_nest_device_id }}"
              GO2RTC_URL: "{{ doorbell_go2rtc_url }}"
              GO2RTC_STREAM: "{{ doorbell_go2rtc_stream }}"
              LM_STUDIO_URL: "{{ doorbell_lm_studio_url }}"
              LM_STUDIO_MODEL: "{{ doorbell_lm_studio_model }}"
              MQTT_URL: "{{ doorbell_mqtt_url }}"
              FRIGATE_CAMERA: "{{ doorbell_frigate_camera }}"
              WINDOW_MS: "{{ doorbell_window_ms }}"
              POLL_MS: "{{ doorbell_poll_ms }}"
              MISS_LIMIT: "{{ doorbell_miss_limit }}"
              QUEUE_MAX: "{{ doorbell_queue_max }}"
              FRAMES_PATH: /frames
            deploy:
              mode: replicated
              replicas: 1
              labels:
                - "home.scheduler.replicas=1"
                - "home.scheduler.priority=60"
              placement:
                constraints:
                  - 'node.labels.home.instance_type == mbp'
              resources:
                limits:
                  cpus: '0.50'
                  memory: 300M
              restart_policy:
                delay: 1m
              update_config:
                order: stop-first
        networks:
          go2rtc_go2rtc:
            external: true
          mosquitto_mosquitto:
            external: true
  vars:
    ansible_python_interpreter: /opt/docker_venv/bin/python
```

Note on `| to_json`: if `config.doorbell.google_credentials` is stored in sops as a YAML mapping, this renders it back to JSON for the env var. If it is stored as a JSON *string*, drop the filter — check which it is before the first deploy.

- [ ] **Step 3: Write the role README**

`roles/doorbell/README.md`:

```markdown
# doorbell

Gates the Frigate `front_door` camera on Nest doorbell activity, and looks for
cats while it is running.

The Nest Doorbell streams badly under continuous load, so Frigate's camera stays
disabled. A Nest event on Pub/Sub opens a 2-minute window — each further event
slides it — and while the window is open the camera is enabled and a frame is
sampled every 30s, run through gemma on LM Studio, and published to Home
Assistant as `binary_sensor.doorbell_cat`. When the events stop, everything
switches back off.

State is entirely in memory. On boot the service publishes everything OFF, which
is the whole recovery story: a window that survived a crash would be wrong anyway.

## Configuration

Non-secret settings live in `defaults/main.yml`. The service account JSON comes
from `config.doorbell.google_credentials` in the sops env submodule.

Created by hand in GCP, not by Ansible:

- pull subscription `nest-events-doorbell` on topic `nest-events`, project `<redacted>`
- a service account with `roles/pubsub.subscriber` on it, and a JSON key

## Frames

Every sampled frame is kept under `/mnt/gluster/doorbell/frames/YYYY-MM-DD/`:
`HHMMSS.raw.jpg` as grabbed, `HHMMSS-cat.jpg` or `HHMMSS-nocat.jpg` annotated, and
`HHMMSS.json` with the model's response. A raw with no annotated sibling is a frame
that failed or was evicted from the queue. Nothing prunes them; they are tuning
artifacts, and Frigate holds the real recordings.

## Deploying

    task deploy --tags doorbell

## Design

`docs/superpowers/specs/2026-09-11-doorbell-design.md`
```

- [ ] **Step 4: Wire into the playbook**

In `playbook.yml`, in the `deploy` play's role list, add after the `frigate` entry:

```yaml
    - role: doorbell
      tags: doorbell
```

- [ ] **Step 5: Wire into the repo README**

In `README.md`, add `- Doorbell` to the roles list between `- Docker Swarm` and `- External USB Drive`.

- [ ] **Step 6: Verify the playbook parses**

Run: `task deploy --tags doorbell --check --list-tasks`
Expected: lists the doorbell tasks with no YAML or undefined-role errors. (`--list-tasks` does not connect to hosts.)

- [ ] **Step 7: Commit**

```bash
git add roles/doorbell playbook.yml README.md
git commit -m "Add doorbell Ansible role"
```

---

### Task 12: Deploy and verify

**Files:** none — this task is the real-world check.

- [ ] **Step 1: Confirm the GCP prerequisites exist**

- Pull subscription `<redacted>` on topic `nest-events`.
- A service account with `roles/pubsub.subscriber` on that subscription.
- Its JSON key at `config.doorbell.google_credentials` in the sops env submodule.

- [ ] **Step 2: Deploy**

```bash
task deploy --tags doorbell
```

- [ ] **Step 3: Check the service came up and reconciled**

```bash
sudo docker service logs doorbell_doorbell --tail 50
```

Expected: `subscribed to <redacted>`, and no errors. A `pubsub subscription failed` line means the credentials or the subscription name are wrong.

- [ ] **Step 4: Check Home Assistant**

Expected: a "Doorbell" device with four entities — `binary_sensor.doorbell_cat` (Clear), `binary_sensor.doorbell_activity` (Not running), `image.doorbell_detection`, `sensor.doorbell_last_detection` — all *available*, not greyed out. Greyed out means the LWT/availability topic is wrong.

- [ ] **Step 5: Exercise the window**

Press the doorbell. Within a few seconds expect: `window open` in the logs, `binary_sensor.doorbell_activity` → Running, `front_door` enabled in Frigate's UI, and a frame under `/mnt/gluster/doorbell/frames/<today>/`.

Then wait two minutes without further events. Expect: `window closed`, activity → Not running, camera disabled in Frigate, cat → Clear.

- [ ] **Step 6: Exercise the positive path**

Hold a phone showing a cat photo up to the doorbell. Expect a `-cat.jpg` in today's frame directory with a red box drawn on it, `binary_sensor.doorbell_cat` → Detected, and the annotated frame visible on `image.doorbell_detection` in Home Assistant.

- [ ] **Step 7: Update the spec status**

Change the spec header's `**Status:** Designed` to `**Status:** Implemented (YYYY-MM-DD)` and commit.
