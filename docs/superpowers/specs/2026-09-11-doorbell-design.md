# Doorbell — Design

**Date:** 2026-09-11
**Branch:** `add-doorbell-role`
**Status:** Implemented (2026-09-11)

## Goal

A new Ansible role, `roles/doorbell`, deploying a single Node/TypeScript service to
the Swarm. It subscribes to Nest doorbell events on Google Cloud Pub/Sub and reacts
two ways at once:

1. **Gates the Frigate camera.** The Nest Doorbell streams poorly under continuous
   load, so Frigate's `front_door` camera stays disabled except during a short
   window kept open by incoming events.
2. **Looks for cats.** While that window is open, it samples frames from go2rtc,
   asks a local gemma vision model whether a cat is in view, and publishes the
   answer to Home Assistant as a discovered MQTT device — with annotated frames
   archived to disk.

Both reactions are driven by exactly one piece of state: whether the window is open.

## Why the window exists

The Nest Doorbell's WebRTC stream is fragile and expensive to hold open — the whole
reason `roles/go2rtc` exists as a patched fork is that the stream barely works at
all (`roles/go2rtc/NEST_DEBUGGING.md`). Leaving Frigate attached to it around the
clock is the failure mode this design avoids.

Nest already tells us when something is happening, over Pub/Sub. So: keep Frigate
off, and switch it on only while Nest says there is something to look at. The vision
work rides along in the same window because that is precisely when a frame grab is
cheap — the stream is already up for Frigate.

## Scope

In scope:

- New role `roles/doorbell`: Node 24 / TypeScript service, `Dockerfile`, `tasks/main.yml`.
- Swarm stack `doorbell`, one service, joined to `go2rtc_go2rtc` and `mosquitto_mosquitto`.
- Pub/Sub streaming-pull subscriber with in-code filtering to the doorbell device.
- Window state machine: open on event, slide on event, close 2 minutes after the last.
- Frigate camera gating over MQTT (`frigate/front_door/enabled/set`).
- Frame sampling from go2rtc every 30s while the window is open, processed through a
  serial queue.
- Cat detection via LM Studio (`gemma-3-12b-it-qat`), JSON parsed from the response.
- Annotated + raw frames and raw model responses persisted to GlusterFS.
- Home Assistant MQTT discovery: two binary sensors, one image, one timestamp sensor.
- Unit tests (`node --test`) for the window machine, the event filter, box parsing
  and scaling, and annotation geometry.
- Wiring into `playbook.yml` and `README.md`.

Out of scope (YAGNI):

- Datadog metrics. Deliberately deferred; the `planner` pattern is there when wanted.
- Any HTTP surface, Traefik route, or DNS record. Nothing talks *to* this service.
- Durable/resumable window state (see Approaches).
- Detecting anything other than cats. The schema carries a `label`, so widening later
  is a prompt change, not a redesign.
- Retention/pruning of saved frames, and rclone backup of them. They are tuning
  artifacts; Frigate holds the real recordings.
- Creating the Pub/Sub subscription or service account. Created by hand, like the
  go2rtc Nest credentials.

## Approaches considered

**A — single Node process, in-memory state.** *Chosen.* One container holding the
window in RAM. A crash loses the window, and the reconcile-on-boot step turns
everything off, which is the correct recovery.

**B — DBOS durable workflows,** as `roles/planner` does. Rejected: the window is two
minutes long and self-clearing. Resuming a half-finished window after a restart is
not more correct than closing it, and the approach costs a Postgres dependency.

**C — two services,** camera gate and vision split apart. Rejected: they share only
the event stream, so the split would either double the Pub/Sub subscribers or add an
internal hop, for two flows of roughly forty lines each.

## Architecture

```
Pub/Sub  projects/<redacted>/subscriptions/nest-events-doorbell
   │  streaming pull, ack immediately
   │  filter (in code): resourceUpdate.name endsWith device_id
   │                 && events ∩ {DoorbellChime.Chime, CameraMotion.Motion,
   │                              CameraPerson.Person, CameraSound.Sound}
   ▼
window.ts ──── open │ slide to now+2min │ close ───────────────┐
   │                                                           │
   ├─ on open  → mqtt  frigate/front_door/enabled/set = ON     │
   │             mqtt  doorbell/activity/state       = ON      │
   │             tick immediately, then every 30s              │
   │                                                           │
   ├─ each tick                                                │
   │    frames.ts    GET http://go2rtc:1984/api/frame.jpeg?src=front_door
   │                 write raw JPEG, enqueue (cap 4, evict oldest)
   │                          │
   │    worker (serial) ──────┘
   │    vision.ts    LM Studio gemma-3-12b-it-qat, JSON parsed from text
   │    annotate.ts  scale 0-1000 boxes to pixels, draw, write annotated + .json
   │                 cat  → occupancy ON,  misses = 0
   │                 none → misses++, at 3 → occupancy OFF
   │                                                           │
   └─ on close → enabled/set OFF, activity OFF, occupancy OFF, stop ticking
```

### Modules

Network lives at the edges; the logic in the middle is pure and tested.

| File | Responsibility | Tested |
|---|---|---|
| `src/window.ts` | the state machine — open, slide, close, tick scheduling | yes, the core |
| `src/presence.ts` | the cat presence latch and its miss counter | yes |
| `src/queue.ts` | bounded serial work queue, evict-oldest | yes |
| `src/events.ts` | Pub/Sub subscription; the filter is a pure function over a decoded message | yes, filter against captured payloads |
| `src/vision.ts` | LM Studio call, response parsing, zod validation, 0-1000 → pixel scaling, cat predicate | yes, parse + scale |
| `src/annotate.ts` | jimp overlay, path layout, writes the annotated JPEG and the response JSON | yes, geometry + paths |
| `src/frames.ts` | go2rtc fetch, timeout, one retry, writes the raw JPEG | thin |
| `src/mqtt.ts` | client, LWT, discovery payloads, publishers | thin |
| `src/config.ts` | env parsing, following `planner`'s `requireEnv` | thin |
| `src/index.ts` | wiring only | no |

## Components

### Event intake (`events.ts`)

`@google-cloud/pubsub` streaming pull against
`projects/<redacted>/subscriptions/nest-events-doorbell`, authenticated with a
service-account JSON passed inline through the environment.

A message opens or slides the window when **both** hold:

- `resourceUpdate.name` ends with the configured device ID
  (`<redacted>`)
- `resourceUpdate.events` contains at least one of
  `sdm.devices.events.DoorbellChime.Chime`,
  `sdm.devices.events.CameraMotion.Motion`,
  `sdm.devices.events.CameraPerson.Person`,
  `sdm.devices.events.CameraSound.Sound`

Filtering happens in code rather than as a subscription filter — the volume is
trivial and changing the event set becomes a deploy rather than a console visit.

**Messages are acked immediately** after the window is updated. These are
notifications, not work: a redelivery only re-slides an already-open window, and a
crash mid-handling should not replay. Nothing is gained by deferring the ack, and
holding it risks the subscription stalling behind a slow gemma call.

Malformed or unparseable messages are logged and acked — a poison message must not
wedge the subscription.

### Window (`window.ts`)

Pure state machine over an injected clock, exposing `onEvent()`, and firing
`onOpen`/`onClose`/`onTick` callbacks.

- **Open** — first qualifying event. Sets `expiresAt = now + WINDOW_MS` (2 min).
- **Slide** — every subsequent qualifying event pushes `expiresAt` out again.
- **Close** — `expiresAt` passes with no new event.
- **Tick** — fires immediately on open, then every `POLL_MS` (30s) until close.

There is **no maximum window length**. Continuous motion holds the window open
indefinitely, and that is intended: sustained activity at the door is exactly when
Frigate should be running.

The miss counter lives in `presence.ts` — it is state about the cat, not about the
window — and **counts evaluated frames only**. A failed frame
grab, an LM Studio error, or a queue eviction does not advance it. Otherwise an
outage would clear the cat sensor — reporting "no cat" when the truth is "no idea".

### Frame sampling and the queue (`frames.ts`)

Each tick fetches `http://go2rtc:1984/api/frame.jpeg?src=front_door` (the service
DNS name on the `go2rtc_go2rtc` overlay, the same host Frigate's RTSP input uses),
writes the raw JPEG to disk, and enqueues the frame for inference.

- **10s timeout.** The first grab after a window opens can be slow while go2rtc
  dials Nest, so a failure is retried once after 3s, then abandoned until the next tick.
- **Serial worker.** One frame in gemma at a time.
- **Queue cap 4, evict oldest.** At ~5s inference against a 30s tick the queue is
  normally empty. The cap only matters when LM Studio degrades: without it, a window
  held open by continuous motion grows the backlog without bound and the cat sensor
  ends up reporting minutes-stale frames. Evicting the oldest keeps the sensor
  tracking the present. Evicted frames keep their raw JPEG, so "every frame is
  saved" still holds.

### Vision (`vision.ts`)

`@lmstudio/sdk` against `ws://<redacted>:1234` — the SDK speaks
WebSocket, and its `baseUrl` option takes a `ws://` URL for the same port — model
`gemma-3-12b-it-qat`, reached by ordinary outbound TCP from the overlay network
through host NAT — no `ipvlan` needed.

The prompt is used verbatim (`PROMPT` in `vision.ts` is the current wording; it asks
for a bare JSON array of `box_2d` / `label` objects and `[]` when there are no cats).

The response is **not** grammar-constrained. A structured-output schema would forbid
the model from reasoning before it answers, so the request is left free-form and the
JSON is parsed back out of the text: `<think>` blocks are dropped, every balanced
top-level `[…]` span is collected, and they are tried last first — whatever the model
settled on comes after whatever it was weighing. The same zod schema still validates
the candidate: an array of
`{ label: string, box_2d: [number, number, number, number] }`, with `bbox_2d`
accepted as an alias because the model writes either name. **Any box labelled cat
counts** — no confidence or size threshold.

The prompt is therefore load-bearing; nothing else keeps the output parseable. A
response that yields no schema-matching array throws, and a throw is already handled
as an inference failure: the frame's `.json` records the error (with a snippet of what
the model said) and the miss counter is left alone. A response nobody can read is not
evidence of no cat.

Coordinates come back on gemma's 0–1000 normalized scale, in **[ymin, xmin, ymax,
xmax]** order — the PaliGemma convention it was trained on, which no prompt overrides
— and are stored that way, so a frame's `.json` matches what the model said. The
y-first reading lives only in `scaleBox`, which maps them onto the real frame
dimensions (512×384 for the current stream, read from the image rather than assumed).

The frame is sent at 2× its captured size. Gemma's soft-token budget scales with the
input's pixels: 512×384 earns ~90 soft tokens, 1024×768 earns ~338. Past ~512 image
tokens the request aborts, and LM Studio exposes neither `max_soft_tokens` nor the
wider ubatch gemma's non-causal image attention would need, so 2× is the ceiling
here. It recovers detail the encoder would otherwise discard; it does not add any.

*Verified against `@lmstudio/sdk@1.5.0`.* `client.files.prepareImage(path)` returns a
`FileHandle`; `ChatMessageInput` takes `images: FileHandle[]`; and
`respond(chat)` returns a `PredictionResult` whose `reasoningContent` and
`nonReasoningContent` split the text on the model's reasoning tags, which is what
keeps a decoy array inside a `<think>` block out of the parser. One consequence of
passing zod schemas to the SDK at all: it depends on
**zod 3** (`^3.22.4`) and extracts a JSON schema from the object passed in, so this
service must depend on zod 3 as well — two zod majors in one dependency tree is the
exact breakage its own typings warn about.

### Annotation and storage (`annotate.ts`)

Up to three files per frame under `/frames` (`/mnt/gluster/doorbell/frames` on the
host), in a `YYYY-MM-DD/` directory:

| File | Written by | When |
|---|---|---|
| `HHMMSS.raw.jpg` | `frames.ts` | at grab time, before anything is known about it |
| `HHMMSS-cat.jpg` / `HHMMSS-nocat.jpg` | `annotate.ts` | after inference, boxes and labels drawn |
| `HHMMSS.json` | `annotate.ts` | after inference: raw model response, or the error |

The verdict is in the annotated filename rather than the raw one because the raw
lands before the verdict exists — renaming it afterwards would be the only
alternative. A frame that was evicted from the queue, failed inference, or failed
its grab therefore has a `.raw.jpg` and possibly a `.json`, but no annotated image;
that asymmetry is how you spot them when skimming a day's directory.

Keeping the raw frame means a future prompt can be re-run against real historical
frames without waiting for a cat to show up. Every sampled frame is kept, hits and
misses alike — the misses are what you need when gemma is wrong.

**jimp, not sharp.** Sharp ships per-platform binaries as optional dependencies, and
yarn 1.22 records only the host platform's in the lockfile; a lockfile generated on
an arm64 Mac then fails `yarn install --frozen-lockfile` inside the amd64 image
build. Jimp is pure JS, has no native dependencies, and draws boxes and label text
adequately at this frame size.

### MQTT (`mqtt.ts`)

Broker `mqtt://mosquitto:1883` on the `mosquitto_mosquitto` overlay, no auth, as
Frigate and Home Assistant already use it.

| Topic | Payload | Retained |
|---|---|---|
| `doorbell/availability` | `online` / `offline` (LWT) | yes |
| `doorbell/cat/state` | `ON` / `OFF` | yes |
| `doorbell/activity/state` | `ON` / `OFF` | yes |
| `doorbell/detection/image` | annotated JPEG bytes | yes |
| `doorbell/detection/last/state` | ISO-8601 timestamp | yes |
| `frigate/front_door/enabled/set` | `ON` / `OFF` | **no** |

The Frigate command is deliberately **not** retained: a retained command replays
itself at every broker or Frigate restart, re-enabling a camera nobody asked for.

Discovery is published retained under `homeassistant/<component>/doorbell/<id>/config`,
with all four entities sharing one `device` block so they group as "Doorbell", and
all four carrying `availability_topic: doorbell/availability`:

| Entity | Component | Notes |
|---|---|---|
| `binary_sensor.doorbell_cat` | `binary_sensor` | `device_class: occupancy` — "Detected / Clear" |
| `binary_sensor.doorbell_activity` | `binary_sensor` | `device_class: running` — window open, i.e. why Frigate is on |
| `image.doorbell_detection` | `image` | latest annotated frame |
| `sensor.doorbell_last_detection` | `sensor` | `device_class: timestamp` |

`availability` rather than a default-off state matters: with the service down the
entities go *unavailable* instead of asserting "no cat".

## Failure handling

- **Reconcile on boot.** Publish discovery, then `enabled/set OFF`, cat OFF,
  activity OFF, availability `online`. Window state is in RAM, so after any crash the
  only correct recovery is "everything off" — this is what makes approach A safe.
- **SIGTERM.** Close the window (so Frigate gets its OFF), publish `offline`, flush,
  exit. The stack's `stop-first` update order gives the ordering.
- **MQTT reconnect.** Republish discovery *and* current state on every `connect`
  event, not only the first.
- **LM Studio error or timeout.** Log, write the raw frame with an error JSON
  sidecar, leave the miss counter alone.
- **go2rtc grab failure.** One retry after 3s, then skip until the next tick. Miss
  counter untouched.
- **Pub/Sub fatal error** (bad credentials, permission denied). Log and exit
  non-zero so Swarm restarts, rather than sitting subscribed to nothing.
- **Frigate already in the requested state.** The command is idempotent; no read-back.

## Deployment

Role shape follows `roles/planner`: `Dockerfile` built and pushed to gitea by
`tasks/main.yml`, then a `community.general.docker_stack` deploy.

- **Image.** `node:24.14-trixie` pinned by digest, `yarn install --frozen-lockfile`,
  `yarn run build`, `USER node`, `CMD ["node", "dist/index.js"]`. amd64 only.
- **Networks.** `go2rtc_go2rtc`, `mosquitto_mosquitto`. No Traefik labels, no
  Cloudflare DNS record.
- **Placement.** `node.labels.home.instance_type == mbp`. One replica.
- **Scheduler labels.** `home.scheduler.replicas=1`, `home.scheduler.priority=60` —
  alongside `frigate`, below `go2rtc` (50) and `mosquitto` (30), since it depends on
  both. Lower numbers scale up first.
- **Resources.** `cpus: '0.50'`, `memory: 300M`. Idle between ticks; jimp on a
  512×384 frame is trivial.
- **Volume.** `/mnt/gluster/doorbell/frames:/frames`, directory created by the role
  as `pi:pi`.
- **Update config.** `order: stop-first`, `restart_policy.delay: 1m`.

### Configuration

Secret, in the sops `env` submodule:

- `config.doorbell.google_credentials` — service-account JSON, reaching the
  container **base64-encoded** as `GOOGLE_CREDENTIALS_BASE64`.

*Why base64, found during the first deploy:* Ansible converts a templated string
that parses as a dict literal into an actual dict, so passing the JSON through raw
makes `docker stack deploy` fail with `must be a string, number or null`. Piping it
through `to_json` instead produces a doubly-encoded string the service would have
to parse twice. Base64 cannot be mistaken for a dict, and it sidesteps quoting the
private key's newlines through YAML as well.

*Trade-off, accepted deliberately:* the credential is still visible in
`docker service inspect` — base64 is encoding, not encryption. A Docker secret via
`roles/docker_secrets` would avoid that; the env var was chosen for simplicity. The
account holds only `roles/pubsub.subscriber` on one subscription.

Non-secret, in `roles/doorbell/defaults/main.yml`:

| Variable              | Value                                                                           |
|-----------------------|---------------------------------------------------------------------------------|
| `PUBSUB_SUBSCRIPTION` | `<redacted>`                                                                    |
| `NEST_DEVICE_ID`      | `<redacted>`                                                                    |
| `GO2RTC_URL`          | `http://go2rtc:1984`                                                            |
| `GO2RTC_STREAM`       | `front_door`                                                                    |
| `LM_STUDIO_URL`       | `ws://<redacted>:1234` (the SDK's `baseUrl` is a WebSocket URL)                 |
| `LM_STUDIO_MODEL`     | `gemma-3-12b-it-qat`                                                            |
| `MQTT_URL`            | `mqtt://mosquitto:1883`                                                         |
| `FRIGATE_CAMERA`      | `front_door`                                                                    |
| `WINDOW_MS`           | `120000`                                                                        |
| `POLL_MS`             | `30000`                                                                         |
| `MISS_LIMIT`          | `3`                                                                             |
| `QUEUE_MAX`           | `4`                                                                             |
| `FRAMES_PATH`         | `/frames`                                                                       |
| `TZ`                  | `America/Los_Angeles`                                                           |

### Manual prerequisites

Created by hand in GCP, not by Ansible — the same posture as the go2rtc Nest
credentials:

1. Pull subscription `nest-events-doorbell` on topic `nest-events`, project `<redacted>`.
2. A service account with `roles/pubsub.subscriber` on that subscription, and a JSON key.
3. That key stored at `config.doorbell.google_credentials` in the sops env submodule.

## Testing

`node --test` over compiled output, matching `planner`'s `test` script. Written
test-first.

- **`window.ts`** — the substance. Open on event; slide on a second event; close
  after `WINDOW_MS` of quiet; tick immediately on open then on interval; ticking
  stops at close; miss counter reaching 3 clears occupancy; a cat resets it to 0;
  errors and evictions leave it untouched; close always emits the OFF trio.
- **`events.ts`** — filter accepts each of the four event types, rejects another
  device's ID, rejects unrelated event types, and survives malformed JSON.
- **`vision.ts`** — parse a well-formed response; empty list means no cat; scale
  0-1000 boxes to 512×384 correctly, including clamping out-of-range coordinates.
- **`annotate.ts`** — path layout for a given timestamp and verdict; box geometry
  stays within image bounds.

Network boundaries (Pub/Sub, go2rtc, LM Studio, MQTT) are injected, so no test
touches the network.

## Verification after deploy

1. `sudo docker service logs doorbell_doorbell` shows the subscription attached and
   the reconcile publishing OFF.
2. Home Assistant shows a "Doorbell" device with four entities, all available.
3. Press the doorbell. Within seconds: `activity` ON, Frigate's `front_door` enabled
   in its UI, a frame appearing under `/mnt/gluster/doorbell/frames/<today>/`.
4. Two minutes after the last event: `activity` OFF, camera disabled, `cat` OFF.
5. Point a phone showing a cat photo at the doorbell to exercise the positive path,
   and check the annotated JPEG has a box on it.
