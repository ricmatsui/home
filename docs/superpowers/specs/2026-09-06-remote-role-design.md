# Remote — Design

**Date:** 2026-09-06
**Branch:** `add-remote-role`
**Status:** Implemented (2026-09-06)

## Goal

Migrate the standalone `tv` project (`/Users/ricardo/synced/Projects/tv`) into this repository as a new Ansible role, `roles/remote`, and collapse its two deployed pieces into one.

Today the app is split: a Flask service running under systemd on `autopi`, plus a separate nginx reverse-proxy Swarm stack on `pi` that fronts it for Traefik. After this change there is a single Docker container, attached to both the Traefik overlay and the `ipvlan` LAN network, reachable at `remote.{config.domain}`.

Separately, the gesture recognition model and its training data stop being files vendored in a private repo and become properly published HuggingFace artifacts that the build and the training loop actually consume.

**Naming.** Everything is named `remote`, not `tv` — including the HuggingFace repositories and the container env vars. The television is the only device driven today, but the name is chosen to leave room for a broader scope later. `tv` survives only where it names the actual appliance (`REMOTE_TV_IP`, `REMOTE_TV_MAC`) or where a foreign protocol demands it (see the Samsung client name).

## Why the two pieces existed

The split was not arbitrary, and understanding it explains the ipvlan requirement.

`tv.py` sends Wake-on-LAN magic packets to the television. A WoL packet is a link-layer broadcast; a container on a Docker overlay or bridge network cannot put one on the LAN. Running the Flask app directly on `autopi` — a host with a real NIC on the LAN — was the way to get that. But `autopi` is not a Swarm node, so it could not be fronted by Traefik directly, hence the `tv-proxy` nginx stack on `pi` doing nothing but `proxy_pass http://${TV_HOST}:5002`.

The `ipvlan` network added since then dissolves the constraint. A container attached to it gets a real address on the LAN segment and can broadcast, so one container can do both jobs.

Note that only WoL genuinely needs ipvlan. The `wss://{tv-ip}:8002` control socket is ordinary outbound TCP and already works from an overlay network through host NAT. Ipvlan here is about egress, not ingress.

## Scope

In scope:

- New role `roles/remote` containing the Flask app, its `Dockerfile`, the training code, and the HuggingFace publishing scripts.
- Single Swarm stack `remote`, one service, joined to `traefik_traefik` and `ipvlan`.
- Cloudflare DNS record and Traefik ingress at `remote.{config.domain}`.
- Explicit, correct WoL egress over the ipvlan interface.
- Move secrets from the `tv` repo's `config.yml` to `config.remote.*` in the sops env submodule.
- Publish a HuggingFace dataset and model; make them the source of truth for training, for the image build, and for the label vector the app runs inference against.
- Split the inline HTML/JS blob out of `tv.py`; modernise the Python dependencies.
- pytest suites for the app and the publishing code, written test-first.
- Persist recordings on GlusterFS and back them up through the existing rclone mechanism.
- Introduce git-lfs to this repository and bring the GIMP `.xcf` sources over.
- Wire into `playbook.yml`, `roles/homepage`, `README.md`, and `tasksfile.js`.
- Decommission the `tv.service` unit on `autopi` and the `tv-proxy` stack on `pi`.

Out of scope (YAGNI):

- Rewriting the frontend as a Vite/TypeScript SPA. The vanilla-JS gesture canvas works; porting it to a build pipeline is a separate project.
- `traefik-forward-auth`. The current `tv-proxy` uses `traefik-internal` only, and a TV remote you want to grab in one tap should stay that way.
- Any change to the gesture set, the model architecture, or the training recipe. This migration must be behaviour-preserving so that a regression is attributable.
- Multi-TV or multi-user support.
- Retraining as part of deploy. Training stays a deliberate manual step.

## Architecture

```
browser ──https──> traefik ──> remote (gunicorn + flask)
                     │           ├─ traefik_traefik  (inbound from traefik)
                     │           └─ ipvlan           (WoL broadcast, wss to TV)
                     └─ middleware: traefik-internal
```

One stack, one service, `replicas: 1`, `update_config.order: stop-first`, no placement constraint.

### Why `replicas: 1` is load-bearing

`tv.py` starts an asyncio worker thread at **import time** which owns the single Samsung control websocket, fed by a `janus` queue handed back through a `queue.Queue`. Two replicas means two websockets competing for the same television, and `stop-first` exists so a rolling update never briefly has two.

The same fact constrains the WSGI server: gunicorn must run `--workers 1 --threads 4`. With N workers the module is imported N times and N websockets open. This is the single easiest way to break this service, so it is called out here, in the plan, and in a comment in the Dockerfile.

### Placement

No constraint. All swarm nodes' `docker_ipvlan_parent` interfaces sit on the same LAN segment as the television, so the container can be scheduled anywhere. This is the reason recordings must live on GlusterFS rather than a node-local path.

## Wake-on-LAN over ipvlan

This is the highest-risk part of the migration and the piece the whole single-container design rests on.

The container has two interfaces. The default route will be the overlay. `wakeonlan.send_magic_packet(mac)` defaults to `255.255.255.255:9`, a limited broadcast, which will follow the default route out of the *wrong* interface and silently do nothing — no error, no packet on the LAN, and a television that does not wake.

The fix is to select the LAN interface explicitly and send a subnet-directed broadcast bound to it:

```python
send_magic_packet(mac, ip_address=lan_broadcast, interface=lan_ip)
```

`wakeonlan`'s `interface` parameter is a source address to bind the socket to, not a device name.

Interface selection is a pure function — given the container's interfaces and a configured LAN CIDR, return `(source_ip, broadcast_address)` — so it is unit-testable without a container. The LAN CIDR comes from an env var (`REMOTE_LAN_CIDR`) fed from the same sops value that backs `config.docker.ipvlan_ipam_config`, rather than being guessed by "whichever interface is not the overlay".

### Interface selection failure takes the whole service down

`TvControl.__init__` calls `select_lan_interface`, which raises `LanInterfaceNotFound` when no interface address falls inside `REMOTE_LAN_CIDR`. It runs inside `create_app()`, so gunicorn never boots and the container crash-loops.

This is deliberate, and it is a genuine availability-for-correctness trade worth stating rather than discovering: the `wss://{tv-ip}:8002` control socket does **not** need ipvlan, so a remote that could still send volume and navigation keys to an already-on television is taken down because Wake-on-LAN cannot be configured.

Fail-fast wins anyway, for the reason the whole section exists. The failure this design is built around is a WoL packet that leaves silently by the wrong interface — no error, no packet, a television that does not wake. A degraded service that quietly cannot wake the television reproduces exactly that, whereas a crash-looping Swarm task is impossible to miss at the moment you caused it. It also matches how `app.js` refuses to start rather than mispredict.

The cost is broader than misconfiguration: per risk 2, a node where the ipvlan attachment fails to come up takes the service down entirely rather than degrading. If that turns out to happen in practice, catching `LanInterfaceNotFound` and disabling only `powerOn` — logging loudly, and surfacing it in the UI rather than only in the logs — is the change to make. It is not the starting position.

**Verification during implementation:** `tcpdump -i <ipvlan parent> 'udp port 9'` on a LAN host while triggering `powerOn`. If the packet does not appear there, the single-container premise does not hold and the design needs revisiting before going further.

## Model artefacts — fetched by Ansible, not by the Dockerfile

The model is not fetched inside the image build. `roles/remote/tasks/main.yml` resolves and downloads it on the control machine immediately before `docker_image_build`, into `{{ role_path }}/static/model/` (gitignored), and the Dockerfile simply `COPY`s that directory.

```yaml
- name: resolve model revision
  ansible.builtin.uri:
    url: "https://huggingface.co/api/models/{{ remote_model_repo }}/revision/{{ remote_model_ref }}"
  delegate_to: localhost
  register: remote_model_info

- name: download model files
  ansible.builtin.get_url:
    url: "https://huggingface.co/{{ remote_model_repo }}/resolve/{{ remote_model_info.json.sha }}/{{ item }}"
    dest: "{{ role_path }}/static/model/{{ item | basename }}"
  loop: "{{ remote_model_info.json.siblings | map(attribute='rfilename')
            | select('match', '^(tfjs/|gestures\\.json$)') | list }}"
  delegate_to: localhost
```

Three things follow from doing it this way:

- **No shard enumeration.** The file list comes from the revision's own `siblings`, so `group1-shard1of1.bin` becoming `1of3` after a bigger model is trained needs no change here. Hardcoding shard filenames — as the first draft of this design did — is exactly the fragility to avoid. (`huggingface_hub.snapshot_download(repo_id, revision=..., allow_patterns=["tfjs/*", "gestures.json"])` does the same job if a Python dependency on the control machine is acceptable; the `uri`/`get_url` pair avoids adding one.)
- **Latest by default, pinnable when needed.** `remote_model_ref` defaults to `main` in `defaults/main.yml`, so a deploy after `remote:publishModel` picks up the new model with no revision-bump commit. Override it with a commit SHA to pin or to roll back.
- **The resolved SHA is recorded, not guessed.** `remote_model_info.json.sha` is stamped on the image as a `home.remote.model_revision` label and printed by the play, so which model a running container serves is always answerable even though the ref floats.

The trade being accepted: deploying the same git commit twice, either side of a model publish, produces different images. That is intended — publishing a model *is* the deploy trigger — but it does mean the image is reproducible only when `remote_model_ref` is pinned.

## Container image

Single-stage `Dockerfile` at the role root, built by `community.docker.docker_image_build` with `delegate_to: localhost`, pushed to `gitea.{domain}/{username}/remote`, deployed by digest via `build_result.image.RepoDigests[0]` — the `ticker`/`planner` idiom.

```
FROM python:3.13-slim@sha256:...
  # install deps from a poetry-exported requirements file
  COPY app templates static ./
  USER 1000
  # exactly one worker: see "Why replicas: 1 is load-bearing"
  CMD gunicorn --workers 1 --threads 4 --bind 0.0.0.0:5002 'app:create_app()'
```

There is no longer a `curl` fetch stage: moving the model download into Ansible removed the only reason for one, and with it the question of which `curlimages/curl` version to pin. The one remaining base image is pinned as `python:3.13-slim@sha256:...` — tag *and* digest, matching `roles/ticker`, `roles/planner`, and `roles/homepage`, where the tag documents what the digest is and the digest is what actually resolves.

Platforms `linux/amd64` and `linux/arm64/v8`, since there is no placement constraint.

`static/model/` is a build-time input produced by the Ansible fetch above and is **not** committed; the role's `.gitignore` excludes it. The `/model/<path:filename>` Flask route is kept as-is, serving from `static/model/`, so `app.js` continues to call `tf.loadLayersModel('/model/model.json')` and tfjs continues to resolve the weight shards relative to it. That route also serves `/model/gestures.json`, the label vector — no new route is needed for it.

`static/gestures.json`, by contrast, *is* committed and ships from git. Because the Dockerfile copies `static/` wholesale, it needs no special handling in the build. See "The label contract".

## Repository layout

```
roles/remote/
  Dockerfile
  pyproject.toml            flask, gunicorn, websockets, janus, wakeonlan
  poetry.lock
  defaults/main.yml         remote_model_repo, remote_model_ref
  tasks/main.yml
  app/
    __init__.py             create_app(), routes
    control.py              websocket worker thread, message queue, WoL
    network.py              LAN interface selection (pure)
    recordings.py           append / delete jsonl
  templates/
    index.html
  static/
    app.js                  gesture capture, rasterise, tfjs inference, dispatch
    styles.css
    gestures.json           source of truth: roster, actions, augmentation flags
    favicon.png  favicon-192.png  help.jpg  manifest.json  remote.svg
    model/                  build-time only, fetched from HF by Ansible; gitignored
      model.json  group1-shard*.bin
      gestures.json         this model's label vector, published with its weights
  assets/
    logo.xcf  help.xcf      GIMP sources, git-lfs
  tests/
    test_recordings.py  test_routes.py  test_network.py
  model/
    pyproject.toml          tensorflow 2.17, tensorflowjs, datasets, huggingface_hub
    poetry.lock
    train.py
    publish_dataset.py
    publish_model.py
    cards/
      dataset_card.md
      model_card.md
    tests/
      test_publish_dataset.py  test_labels.py
```

Nesting a second poetry project under `model/` mirrors what the `tv` repo already did, and matches how `roles/ticker` and `roles/planner` carry a full node app inside a role.

### Frontend changes

The ~450-line blob inside `render_template_string` becomes `templates/index.html` plus `static/app.js` and `static/styles.css`. Behaviour is unchanged.

`app.js` fetches two label files rather than one — `gestures.json` for the roster and the action map, `/model/gestures.json` for the model's output-index mapping — and looks up actions by name rather than by array index. See "The label contract".

One dependency change comes with the split:

- **htmx is dropped.** It is used for exactly three fire-and-forget POSTs (`/control`, `/record`, `/delete`). `fetch()` covers that without a 14KB dependency.

**tfjs stays on `cdn.jsdelivr.net`**, loaded by a version-pinned `<script>` tag in `index.html` rather than vendored into the image. This is a deliberate acceptance of the offline caveat: a WAN outage while the page is not already in the browser cache means no inference, on a LAN remote that would otherwise still work. Vendoring is a small change to make later if that ever actually bites. The pinned version must stay aligned with the tfjs-converter version used to produce the model — see risks.

### Python dependency changes

The current pip list in the `tv` playbook has around 25 packages because it was a `virtualenv_site_packages: true` venv on Raspberry Pi OS, so it pinned the system packages it inherited: `gpiozero`, `pigpio`, `rpi-lgpio`, `spidev`, `smbus2`, `python-apt`, `rpi-keyboard-config`, and so on. None of it is used by `tv.py`. In a container the real dependency set is:

```
flask  gunicorn  websockets  janus  wakeonlan
```

Flask moves from 1.1.4 to 3.x (the 1.1.4/Jinja2 2.11.3 pin only existed to satisfy the inherited system packages). `flask.render_template_string` becomes `render_template`; nothing else in the app touches API surface that changed.

The role's `pyproject.toml` targets `^3.13` to match the container base image, so the pytest suite runs against the same interpreter the service does.

## Configuration

`config.tv.*` in the `tv` repo's `config.yml` becomes `config.remote.*` in the sops env submodule:

| old | new | notes |
|---|---|---|
| `config.tv.ip` | `config.remote.ip` | television LAN address |
| `config.tv.mac` | `config.remote.mac` | WoL target |
| `config.tv.token` | `config.remote.token` | Samsung pairing token |
| `config.tv.tv_host` | — | dropped; the container binds `0.0.0.0` |

Delivery changes from a base64-encoded JSON blob in a systemd `Environment=` line to discrete container env vars: `REMOTE_TV_IP`, `REMOTE_TV_MAC`, `REMOTE_TV_TOKEN`, plus `REMOTE_LAN_CIDR`.

**The Samsung token is bound to the client name.** `tv.py` connects with `name=` set to the base64 of the literal string `NodeJS-Test`. Samsung ties an issued token to that name; change it and the television will refuse the token and re-prompt for pairing on screen. The string must be carried over byte-identical — it is the one place the rename must *not* reach.

## Persistence

`/mnt/gluster/remote/data/` created by the role, owned by `pi:pi` (1000), mounted into the container at `/data`. `recordings.jsonl` lives there, so the container can be rescheduled onto any node without losing the training data.

Gluster is a deliberate choice over a node-local volume given the lack of a placement constraint. The file is append-only and written by a single replica, so it does not resemble the concurrent-write patterns that have caused gfid split-brains on `gv0`.

### Backup

`recordings.jsonl` is the only irreplaceable state this service holds — every recorded gesture that has not yet been published to HuggingFace exists nowhere else. The role installs a script into the existing rclone mechanism, following `roles/paper` (a dated copy of a live, mutable file rather than a sqlite or squashfs snapshot):

```yaml
- name: configure backup
  ansible.builtin.copy:
    dest: /mnt/gluster/rclone/scripts/remote.sh
    mode: u=rwx,g=rx,o=rx
    content: |
      #!/bin/bash
      . /mnt/gluster/rclone/functions

      rclone copyto /mnt/gluster/remote/data/recordings.jsonl \
        :s3:/$ARCHIVE_PATH/$BACKUP_DATE/remote/recordings.jsonl
```

No `stop_docker_service` dance: the file is append-only and a torn read at worst loses the final partial line, which the dataset publisher rejects anyway.

`recordings.py` also fixes a latent bug: `/delete` currently opens `recordings.jsonl` for reading unconditionally and raises `FileNotFoundError` if nothing has been recorded yet.

## The label contract

`gestures.json` carries three things:

1. **Order** — the array index is simultaneously the model's output index and the dataset's `ClassLabel` index.
2. **`action`** — the mapping from a gesture name to a Samsung key or app deep-link.
3. **Augmentation flags** — `allowMirrorHorizontal`, `allowMirrorVertical`, `allowRotation`, `allowSlanted`, consumed only by `train.py`.

The source of truth is `roles/remote/static/gestures.json`, committed to git.

### Why the app reads two files

Those three things do not share a timing requirement, and that is the whole design:

| contract | consumer | timing |
|---|---|---|
| index → name | inference | must match the deployed weights **exactly** |
| name → action | key dispatch | independent of any model; name-keyed |
| roster of names | record mode | must run **ahead** of the model |
| order + flags | `train.py` | repo-only, never served to the browser |

Recording is what forces the split. To add an eleventh gesture you need training samples for it; samples come from record mode; record mode only prompts for gestures in the file it was served. If that file shipped with the weights, the eleventh gesture could never be recorded, because no model would list it until one had been trained on samples that could not be collected. The roster has to be allowed to run ahead of the model.

Inference has the opposite requirement: its index → name mapping must be locked to the weights, or the remote confidently sends the wrong keys.

So the container serves two files:

- **`/gestures.json`** → `static/gestures.json`, copied from git at build time. The roster and the action map.
- **`/model/gestures.json`** → `static/model/gestures.json`, downloaded from HuggingFace with the weights. This model's label vector.

`app.js` picks record prompts from the roster, maps a prediction index through the label vector to a name, and then looks the action up **by name**:

```javascript
const gesture = actions.get(labels[result.index].name);
```

That name-keyed lookup is the point. The current code writes `gestures[result.index]`, one array index answering two different questions — which class did the model predict, and what should happen as a result. Splitting the files forces those apart, which is exactly the conflation that made a permuted label order such a dangerous failure mode.

### Enforcement

`app.js` validates on load and refuses to run rather than mispredicting:

- `labels.length` equals the model's output width (`model.outputs[0].shape[1]`). Catches a botched publish where weights and label vector disagree.
- Every name in `labels` exists in the roster. A model predicting a class the app has no action for is a configuration error, and it should surface at page load, not on the first gesture.

The asymmetry is deliberate: **roster ⊃ labels is legal** — the extra names are gestures pending training — while a label with no action is fatal.

Elsewhere:

- `publish_dataset.py` derives the `ClassLabel` names from `static/gestures.json`.
- `train.py` asserts the loaded dataset's `ClassLabel` names equal that order and aborts on mismatch rather than silently training a model whose outputs are permuted.
- `publish_model.py` uploads `gestures.json` alongside the weights and writes the same order into the model card.

One consequence worth naming: **reordering `static/gestures.json` is no longer dangerous.** Inference reads the published order, so a reorder without a retrain leaves the deployed app correct; the mismatch surfaces at the next `train.py` assertion instead of as a remote sending wrong keys.

### Adding a gesture

The roster shipping from git is what makes this possible at all:

1. Append the gesture to `static/gestures.json` — append, so existing indices never permute.
2. `task deploy --tags remote`. Record mode now prompts for it; inference still runs on the old model and ignores it.
3. Record samples.
4. `task remote:publishDataset` → `task remote:train` → `task remote:publishModel`.
5. `task deploy --tags remote`. The new label vector arrives with the new weights.

Between steps 2 and 5 the new gesture is recordable but not predictable — drawn in normal use it either misclassifies into an existing class or falls below the 0.6 threshold and reads as "unknown". That is the same behaviour as any unrecognised input, so nothing breaks, but record mode gives no visual hint which prompts the deployed model cannot yet predict. Marking them is a small addition (the roster/label set difference is already computed for the load-time check) and is not planned.

## HuggingFace

Both repositories public. `HF_TOKEN` comes from the standard `huggingface-cli login` cache on the dev machine; it is not added to sops, because publishing is never something the cluster does. Note that the *fetch* side is anonymous — Ansible pulls public files with no token — so a deploy never needs HF credentials.

### Dataset — `{hf-user}/remote-gestures`

Parquet, features `{image: Image, label: ClassLabel(names=[...])}`, 3462 samples converted from `recordings.jsonl`.

The dataset card documents the rasterisation pipeline precisely, because it is not recoverable from the images alone and a consumer cannot reproduce inputs without it:

- Pointer samples are collected with a minimum spacing of `clientWidth / 100`.
- The stroke's bounding box is scaled to fit a 32×32 canvas with 2px padding, preserving aspect ratio, and centred.
- Drawn on black with `lineWidth 2`, `lineCap`/`lineJoin` round.
- **Stroke colour ramps from `hsl(0,0%,10%)` to `hsl(0,0%,90%)` along the stroke.** The greyscale gradient encodes stroke *direction*, which is what lets a single 32×32 image distinguish `circle` from `counterCircle`. This is the non-obvious property of the dataset.
- Converted to single-channel L and scaled to `[0,1]` at training time.

The card also carries the per-class distribution, the split methodology (stratified 80/20, `split_data`), and limitations: a single author, a single device, one screen geometry, and no adversarial or accidental-input examples.

Licence `cc-by-4.0`.

### Model — `{hf-user}/remote-gesture`

Contents: `model.keras`, `tfjs/model.json`, `tfjs/` weight shards, `gestures.json`.

Card frontmatter: `license: mit`, `library_name: keras`, `tags: [tensorflowjs, image-classification, gesture-recognition]`, `datasets: [{hf-user}/remote-gestures]`, plus a `model-index` with the validation accuracy.

Card body documents:

- **Architecture** — `Input(32,32,1)` → `Conv2D(32,3,relu,same)` → `MaxPool2D(2)` → `Conv2D(64,3,relu,same)` → `MaxPool2D(2)` → `Flatten` → `Dense(128,relu)` → `Dropout(0.4)` → `Dense(n_classes,softmax)`.
- **Training recipe** — `CosineDecayRestarts(1e-4, first_decay_steps=50, t_mul=2.0, m_mul=0.9, alpha=1e-7)`, legacy Adam with `clipnorm=1.0`, batch 32, up to 500 epochs, `EarlyStopping(monitor='val_loss', patience=30, restore_best_weights=True, min_delta=1e-4)`.
- **Augmentation** — the per-class policy driven by the `gestures.json` flags, oversampling each class to 10,000 examples, with `RandomZoom((-0.1,0.3))`, `RandomRotation(0.02)`, `RandomTranslation(0.1,0.1)` applied to all, and the flag-gated flips and rotations on top. Note that augmentation is applied **after** the train/validation split, so the validation set is un-augmented real data.
- **Intended use and the inference threshold** — the application rejects any prediction with `topk` confidence below **0.6** and treats it as "unknown" (a triple vibration and no key sent). That threshold is part of how the model is actually used and belongs on the card, not just in `app.js`.
- **`gestures.json`** — published alongside the weights as the label vector for this specific model. Its `action` and augmentation fields are properties of the application and the training recipe rather than of the model; they are carried for the reader's benefit, and the app takes only the names from this copy.
- **Limitations** — trained on one person's handwriting on one device; the direction-encoding ramp means the model is sensitive to stroke order, not just shape.

### Publishing scripts

`publish_dataset.py` and `publish_model.py` use `huggingface_hub.HfApi.upload_folder` with an explicit commit message and print the resulting commit SHA. With `remote_model_ref` defaulting to `main` the SHA is informational rather than something to paste anywhere, but it is what you pin to when rolling back.

## Ingress

- **DNS:** Cloudflare A record `remote.{config.domain}` → `{config.ip}`, `community.general.cloudflare_dns`, `delegate_to: localhost`.
- **Traefik labels:**

  ```
  traefik.http.routers.remote.rule=Host(`remote.{{ config.domain }}`)
  traefik.http.routers.remote.middlewares=traefik-internal
  traefik.http.routers.remote.entrypoints=websecure
  traefik.http.routers.remote.tls.certresolver=letsencrypt
  traefik.http.services.remote.loadbalancer.server.port=5002
  ```

- **No sherpa labels.** Nothing needs to reach the container inbound over ipvlan; the attachment exists for egress.

TLS matters beyond privacy here: `navigator.wakeLock.request('screen')` and the PWA manifest both require a secure context, and the page calls `wakeLock` on load to stop the phone dimming mid-session.

## Resource limits

| service | cpu  | memory |
|---------|------|--------|
| remote  | 0.25 | 128M   |

Up from the nginx proxy's `0.15 / 10M`, because this container is now running Python, Flask, and a persistent websocket rather than proxying. The figure is a starting point to be checked against actual usage after deploy.

## Workflow

`tasksfile.js` gains a nested namespace:

| task | does |
|---|---|
| `task remote:publishDataset` | scp `recordings.jsonl` from `pi`, jsonl → parquet, push to HF |
| `task remote:train` | `load_dataset` from HF, assert labels, augment, train, write keras + tfjs to `model/out/` |
| `task remote:publishModel` | upload `model/out/` and the card, print the commit SHA |
| `task remote:monitorTraining` | tensorboard on `model/logs` |

Names are camelCase because `tasksfile` exposes the exported key verbatim, as `monitorTraining` already did in the `tv` repo.

**Download is folded into `publishDataset`** rather than being its own task. There is no realistic reason to pull the recordings without publishing them — the local jsonl is a staging file, not something to hold on to — and two tasks invite publishing a stale copy. `publishDataset` scps to a gitignored `model/recordings.jsonl` and converts from there, so the intermediate is still on disk to inspect after a run.

The full loop: record in the app → `remote:publishDataset` → `remote:train` → `remote:publishModel` → `task deploy --tags remote`. No revision-bump commit in the middle, since `remote_model_ref` floats on `main`.

`remote:publishDataset` uses a plain `ssh`. The `TERM=xterm /usr/bin/ssh` workaround used elsewhere for non-interactive ssh from kitty is deliberately *not* applied up front — it is worth confirming whether it is still needed here before carrying it forward. If the scp hangs or misbehaves under kitty during implementation, fall back to the workaround and note it in the task.

`model/logs/` and `model/out/` are gitignored, as they were in the `tv` repo.

## Testing

pytest, written test-first, in two suites.

`roles/remote/tests/` (app poetry env):

- `test_smoke.py` — `static/gestures.json` parses and its array order is exactly the ten expected names. The cheapest possible pin on the label order, and the test that proves the harness runs at all.
- `test_network.py` — interface selection returns the ipvlan source address and the correct directed broadcast for a given CIDR; raises clearly when no interface matches; is not fooled by the overlay interface. Table-driven over synthetic interface lists.
- `test_recordings.py` — append writes one valid JSON line; delete removes the last line; delete against a missing or empty file does not raise (the current bug); append then delete is a no-op.
- `test_routes.py` — `/gestures.json` serves the committed roster with `no-cache`; `/model/gestures.json` serves the fetched label vector and 404s cleanly when `static/model/` has not been populated; `/control` parses the form field and enqueues the message; `/record` appends; a path outside `static/model` 404s rather than escaping the directory.

`roles/remote/model/tests/` (model poetry env):

- `test_labels.py` — the `ClassLabel` names produced by `publish_dataset` equal the `static/gestures.json` order, and the model card's label list matches. This is the authoritative pin on the publishing side of the contract; the browser side is enforced at load time by `app.js`.
- `test_publish_dataset.py` — a jsonl line round-trips to parquet preserving the label and a 32×32 single-channel image; a row with an unknown gesture name is rejected rather than silently dropped.

The websocket worker is not unit-tested; it is verified manually against the television, as it is today.

## Assets and git-lfs

The `tv` repo tracks `assets/*.xcf` (GIMP sources for the logo and the help image, ~232KB) through git-lfs. This repository has no `.gitattributes` and no LFS configuration, so the migration introduces it:

- Root `.gitattributes` gains `*.xcf filter=lfs diff=lfs merge=lfs -text`, matching the `tv` repo's rule verbatim.
- `git lfs install` on the dev machine; Gitea already serves LFS for the `tv` repo over the same origin, so no server-side change is needed.
- The sources move to `roles/remote/assets/logo.xcf` and `roles/remote/assets/help.xcf`.
- The exported artefacts move to `static/` as before: `favicon.png`, `favicon-192.png`, `help.jpg`, `remote.svg`.

Bringing the sources over means archiving the `tv` repository does not strand the only editable copies of the artwork. The cost is that anyone cloning `home` now needs `git-lfs` installed, which is the reason to do it deliberately and note it in `README.md`.

## Decommissioning

The `tv` repo's playbook cannot undo itself, so this is an explicit ordered procedure. **Order matters, because `/opt/tv/recordings.jsonl` on `autopi` is the only copy of the training data.**

1. Copy `recordings.jsonl` off `autopi`, seed `/mnt/gluster/remote/data/recordings.jsonl` with it, and publish the HuggingFace dataset. Verify the dataset loads before continuing.
2. Deploy `roles/remote` and confirm the new container works end to end, including WoL.
3. `docker stack rm tv-proxy` on `pi`.
4. On `autopi`: `systemctl disable --now tv`, remove `/etc/systemd/system/tv.service`, `daemon-reload`, remove `/opt/tv` and `/opt/tv_venv`.
5. Delete the `tv.{domain}` Cloudflare A record.
6. Archive the `tv` repository in Gitea — after confirming the `.xcf` sources are in `home` and pulling clean through LFS.

Steps 3–6 are deliberately after a working deploy, so a rollback is just re-pointing DNS.

### Outcome — 2026-09-06

Steps 1–4 are done. The training data was reconciled first: the `autopi` copy, the
working copy, the desktop backup, and the live GlusterFS file all had the same
SHA-256 over 3461 lines, and the HuggingFace dataset holds the same 3461 samples,
so nothing was removed while it was the only copy of anything. `tv-proxy` is gone
from `pi`; `tv.service` is disabled, removed, and `daemon-reload`ed on `autopi`;
`/opt/tv` and `/opt/tv_venv` are deleted and nothing listens on 5002 there.

`/opt/tv` also held `dollar.js` and `gestures.js` — the $1 Unistroke Recognizer
and its templates, left behind by the old playbook, which does not prune. Neither
is referenced by `tv.py` or by the port, and both were removed from the `tv`
repository in commit `cbff07d` ("Switch to machine learning model"), so archiving
rather than deleting that repository keeps them reachable.

Two steps remain, both requiring a human at a web UI:

- **Step 5**, deleting the `tv.{domain}` A record. The record still resolves, but
  the hostname already returns 404 through Traefik now that the proxy router is
  gone, so it is functionally dead. `community.general.cloudflare_dns` with
  `state: absent` is not a usable alternative here — it fails with
  `KeyError: 'zone_id'` in `delete_dns_records` regardless of whether `value` is
  supplied.
- **Step 7**, archiving the `tv` repository. Its precondition is met: both `.xcf`
  sources are tracked by LFS, `git lfs fsck` passes, and a fresh clone from Gitea
  smudges them to real `GIMP XCF image data` rather than pointer files.

## Other wiring

- `playbook.yml`: add `- role: remote / tags: remote` to the `deploy` play.
- `roles/homepage/files/public/index.html`: add a Remote entry using the `<!--#echo var="domain"-->` idiom.
- `README.md`: add "TV Remote" to the service list, and a git-lfs prerequisite note.
- Datadog HTTP check: to be added by the user in the sops env submodule.

## Deployment — verified 2026-09-06

Deployed and confirmed working end to end. One replica, one gunicorn worker, both
networks attached, `wol will use source 192.168.1.16 broadcast 192.168.1.255` in
the startup log, the `home.remote.model_revision` label carrying
`01256d0cced7e8af5b52bbe675ee2514764bc2a8`, and every route serving over HTTPS.
The ten gestures, the key dispatch, and the Wake-on-LAN wake were confirmed
against the real television by hand.

The model is `ricmatsui/remote-gesture` at that revision — 99.71% validation
accuracy, restored by early stopping from epoch 42 of 72. The dataset is
`ricmatsui/remote-gestures`, 3461 samples.

**One gap in the plan, found at deploy time and fixed.** Nothing in the task list
seeded `/mnt/gluster/remote/data/recordings.jsonl`; the decommissioning procedure
below assumes it, but no implementation step performed it. An empty log there is
not a benign starting state: `publish_dataset.py` rebuilds the HuggingFace dataset
from that file wholesale, so the first `remote:publishDataset` after deploy would
have replaced 3461 samples with whatever had been recorded since. It was seeded
from the `autopi` copy before any recording took place. Anyone repeating this
migration must seed it between deploying and publishing.

## Risks and things to verify during implementation

1. **WoL egress over ipvlan — RESOLVED 2026-09-06, the premise holds.** A container on the `ipvlan` network can put a magic packet on the LAN, and the naive call cannot. Measured, not inferred:

   A throwaway one-shot Swarm service on `pi`, attached to `ipvlan`, was given `192.168.1.16/24` — an address from the `iprange` in `config.docker.ipvlan_ipam_config`. A UDP listener bound to `0.0.0.0:9` on `cannoli`, a *different physical host* on the same segment, recorded exactly one packet across both attempts:

   ```
   PACKET from=192.168.1.16:39003 len=102 sync=ffffffffffff mac=b8bc5b034d04
   ```

   102 bytes, the 6-byte `ff` sync stream, and the television's MAC repeated — a well-formed magic packet that left the container, crossed the LAN, and arrived on another machine. That packet is `send_magic_packet(mac, ip_address='192.168.1.255', interface='192.168.1.16')`. The bare `send_magic_packet(mac)` immediately before it raised no error, reported success, and **put nothing on the LAN** — exactly the silent failure this section is built around.

   Two details worth keeping, because they make the negative result *stronger* than the design assumed:

   - The probe had **only** the ipvlan interface attached — no overlay, so the LAN was the default route — and the limited broadcast still did not arrive. The spec attributed the failure to `255.255.255.255` following the overlay default route; the real cause is lower down (ipvlan L2 mode does not carry limited broadcast off the slave). The fix is the same either way, and it is not contingent on which interface happens to be the default route. Binding explicitly is not merely the tidier option; it is the only thing that works.
   - `config.docker.ipvlan_ipam_config` is `subnet: 192.168.1.0/24`, `gateway: 192.168.1.1`, `iprange: 192.168.1.16/28`. The television is `192.168.1.104` — inside the subnet, outside the container range, which is the intended arrangement. `REMOTE_LAN_CIDR` is `192.168.1.0/24`; the derived broadcast is `192.168.1.255`.

   One correction to the plan's procedure, for anyone repeating this: `docker run --network ipvlan` fails with `network ipvlan not manually attachable`, because the swarm-scoped network is not created `attachable`. Use a one-shot Swarm service (`docker service create --restart-condition none`) instead, which is also closer to how the service actually runs. No node had `tcpdump` installed; a UDP socket bound to port 9 receives the magic packet directly and needs nothing added to a host.
2. **Per-node ipvlan attachment.** All four hosts carrying `docker_ipvlan_parent` — `pi`, `cannoli`, `gelato`, `tart` — are on the television's LAN segment, confirmed by Ricardo on 2026-09-06 and independently measured the same day by reading each node's parent interface directly: `pi` `eth0 192.168.1.219/24`, `cannoli` `enp0s1 192.168.1.115/24`, `gelato` `enp0s1 192.168.1.119/24`, `tart` `eth0 192.168.1.218/24`. All four are on `192.168.1.0/24` with the television at `192.168.1.104`. The absence of a placement constraint rests on that, and it is settled: no constraint is needed, and the `instance_type == mbp` / `instance_size == large` pair used by `home_assistant` and `sync` is a sizing constraint for those workloads that should not be copied here.

   What remained worth checking was the plumbing rather than the topology — that the ipvlan attachment actually comes up on each node, which is a Docker and interface-state question, not a network-layout one. **Verified on two nodes 2026-09-06.** A `--force` update alone is not sufficient to test this: Swarm rescheduled the task back onto `pi`. Constraining the service to `cannoli` temporarily, then removing the constraint, is what actually exercises a second node. On `cannoli` the container took `192.168.1.18` — a different address from the same `192.168.1.16/28` range — resolved the same `192.168.1.255` broadcast, served correctly through Traefik, and saw the same `recordings.jsonl`, which is also the check that justifies GlusterFS over a node-local volume. `gelato` and `tart` are untested.

   Combined with the fail-fast behaviour above, a node where the attachment fails does not merely lose WoL; it takes the service down until Swarm reschedules it elsewhere.
3. **Samsung client name.** Keep `NodeJS-Test` byte-identical or lose the pairing token.
4. **The roster and the label vector diverging in the wrong direction.** `roster ⊃ labels` is normal; a label with no matching action means a model was trained against a `gestures.json` that has since been edited. `app.js` refuses to start in that case, which is the intended behaviour but will look like an outage — check the browser console before assuming the deploy failed.
5. **tfjs version alignment.** The current model was converted by tfjs-converter 4.22.0 and loaded by tfjs 4.20.0. The runtime version now lives in a CDN `<script>` tag rather than a build arg, which makes it easier to drift — keep it aligned with the converter version recorded on the model card when republishing.
6. **A floating model ref makes deploys non-deterministic.** `remote_model_ref: main` means a deploy can ship a model nobody intended to release yet. Mitigated by the recorded SHA label; if it becomes a problem, pin the ref.
7. **gunicorn worker count.** Exactly one, for the reason in "Architecture".
8. **Image size.** A Python base plus the app will be far larger than the 10MB nginx image. Not a problem, but the memory limit and any pull-time assumptions should be re-checked after the first build.
9. **Base image digest.** Pin `python:3.13-slim` by tag and sha256 at implementation time.
10. **git-lfs adoption.** First LFS use in this repository. Verify a fresh clone smudges the `.xcf` files correctly before archiving `tv`.
11. **HF namespace.** The design assumes `{hf-user}` is `ricmatsui`; confirm before creating the repositories.
