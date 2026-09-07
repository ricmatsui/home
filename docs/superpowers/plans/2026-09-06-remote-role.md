# Remote Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the standalone `tv` project into `roles/remote` as a single Docker container on the Swarm — replacing the `autopi` systemd service plus the `tv-proxy` nginx stack — and publish its gesture model and dataset to HuggingFace as the source of truth for training and for the image build.

**Architecture:** One Flask app behind gunicorn, deployed as a one-service Swarm stack joined to both `traefik_traefik` (inbound, via Traefik at `remote.{domain}`) and `ipvlan` (outbound, so Wake-on-LAN broadcasts reach the television). The tfjs model is downloaded from HuggingFace by Ansible on the control machine just before the image build, and copied into the image; tfjs itself stays on the CDN. Training reads its dataset from HuggingFace.

**Tech Stack:** Python 3.13, Flask 3, gunicorn, websockets, janus, wakeonlan, ifaddr; TensorFlow 2.17 + tensorflowjs + `datasets` + `huggingface_hub` for training; Docker Swarm; Ansible; pytest.

**Spec:** `docs/superpowers/specs/2026-09-06-remote-role-design.md`

## Global Constraints

- **Source project:** `/Users/ricardo/synced/Projects/tv`. Referred to below as `$TV`. It is a separate git repository; nothing in it is modified until Task 16.
- **Role directory:** `roles/remote` (already exists, empty and untracked).
- **Ansible tag:** `remote`. Deploy with `task deploy --tags remote`.
- **Deploying from inside a role directory** needs the repo root as *both* the direnv environment and the working directory — two separate breakages, and `direnv exec` alone only fixes one:

  ```bash
  direnv exec /Users/ricardo/synced/Projects/home \
    sh -c 'cd /Users/ricardo/synced/Projects/home && task deploy --tags remote'
  ```

  PATH: the root `.envrc` does `PATH_add node_modules/.bin`, where `task` lives; a role with its own `.envrc` shadows it. Working directory: `task` reads `tasksfile.js` from cwd and only the root has one — a bare `direnv exec <root> task deploy` fails with `/bin/sh: undefined: command not found`, because the `deploy` task never resolves and an empty command reaches the shell.
- **Deploys need `dangerouslyDisableSandbox`.** Ansible needs network access and the Docker socket.
- **Non-interactive ssh/scp** uses plain `ssh`/`scp`. There is a known kitty workaround — prefix `TERM=xterm` and use `/usr/bin/ssh` (`scp -S /usr/bin/ssh`) — which this plan deliberately does *not* apply up front, to find out whether it is still needed. If an ssh or scp step hangs or errors on terminfo, apply the workaround at that step and note it.
- **`replicas: 1` and `gunicorn --workers 1`.** Non-negotiable. The websocket worker thread starts at module import; more than one of either means more than one control socket fighting over the television.
- **`update_config.order: stop-first`** for the same reason.
- **Samsung client name is the literal string `NodeJS-Test`.** The pairing token is bound to it. Never change it.
- **Confidence threshold is `0.6`.** Predictions below it are "unknown": triple vibrate, no key sent.
- **Canvas rasterisation is fixed:** 32×32, padding 2, aspect preserved, centred, black background, `lineWidth 2`, round cap/join, stroke colour ramping `hsl(0, 0%, 10%)` → `hsl(0, 0%, 90%)` along the stroke. The ramp encodes direction and is what distinguishes `circle` from `counterCircle`. Do not "clean it up".
- **Label order** is `roles/remote/static/gestures.json` array order, and it is simultaneously the model output index and the dataset `ClassLabel` index. Append new gestures at the end; never reorder existing ones in the same change as a retrain.
- **The app reads two label files.** `static/gestures.json` (committed, the roster and the action map) drives record prompts and key dispatch; `static/model/gestures.json` (fetched from HuggingFace with the weights) is the label vector inference maps indices through. Actions are looked up **by name**, never by prediction index. This is what lets a new gesture be recorded before any model knows it exists — see the spec's "The label contract".
- **Base image pinned by tag *and* sha256** (`python:3.13-slim@sha256:…`), matching the convention in `roles/ticker`, `roles/planner`, and `roles/impression` — the tag documents what the digest is, the digest is what resolves.
- **Build platforms:** `linux/amd64` and `linux/arm64/v8`.
- **Python version:** `^3.13` for the app; `^3.9` for `model/` (TensorFlow 2.17 constraint, carried over from `$TV/model/pyproject.toml` unchanged).
- **Commit style:** short imperative subject, no prefix. Match the existing log (`Ask who did a Ticker chore only on the public board`, `Seed a journal section in each planner day file`).
- **No behaviour changes** to the gesture set, model architecture, or training recipe. This migration must be attributable if it regresses.

---

### Task 1: Verify Wake-on-LAN egress over ipvlan

**This task is a gate.** The entire single-container design assumes a container on the `ipvlan` network can put a broadcast frame on the LAN. If it cannot, stop and revisit the spec before writing any code. Nothing else in this plan is worth doing until this is proven.

**Files:** none. This is a throwaway probe.

**Interfaces:**
- Consumes: nothing.
- Produces: a confirmed answer, plus the LAN CIDR value that Task 12 puts into `REMOTE_LAN_CIDR`.

**Settled, no longer an open question:** all four hosts carrying `docker_ipvlan_parent` — `pi`, `cannoli`, `gelato`, `tart` — are on the television's LAN segment, confirmed by Ricardo on 2026-09-06. That is what the absence of a placement constraint rests on, so do not add one, and in particular do not reach for the `instance_type == mbp` / `instance_size == large` pair that `home_assistant` and `sync` use — that is about workload size and says nothing about ipvlan.

Task 15's reschedule test still runs, but it is now checking that the ipvlan attachment comes up on each node, not whether the segment assumption holds. A failure there is a Docker or interface-state problem to debug, not a reason to revisit the design.

- [ ] **Step 1: Read the LAN CIDR out of the sops env**

```bash
cd /Users/ricardo/synced/Projects/home
sops -d env/inventory/group_vars/all.sops.yml | grep -A6 ipvlan_ipam_config
```

Note the `subnet` value. That is `REMOTE_LAN_CIDR`. Also confirm the television's address (`config.tv.ip` in `$TV/config.yml`) falls inside it — if it does not, the design is wrong and you should stop here.

- [ ] **Step 2: Start a listener on a LAN host**

On a machine on the LAN that is not the Docker node (a laptop is fine), start:

```bash
sudo tcpdump -ni any 'udp port 9'
```

Leave it running.

- [ ] **Step 3: Launch a throwaway container on the ipvlan network**

```bash
ssh pi 'docker run --rm -it --network ipvlan python:3.13-slim bash'
```

Inside it:

```bash
pip install wakeonlan ifaddr
```

- [ ] **Step 4: Send a limited broadcast — expect this to FAIL**

Inside the container, with `<MAC>` the television's MAC:

```python
python -c "from wakeonlan import send_magic_packet; send_magic_packet('<MAC>')"
```

Expected: **nothing appears in tcpdump.** This is the failure mode the spec predicts — the default route is the overlay, so the `255.255.255.255` packet leaves the wrong interface. If a packet *does* appear, note that and carry on; it does not change the implementation, which binds explicitly either way.

- [ ] **Step 5: Send a directed broadcast bound to the ipvlan address — expect this to SUCCEED**

Inside the container:

```python
python - <<'EOF'
import ifaddr
from wakeonlan import send_magic_packet

for adapter in ifaddr.get_adapters():
    for ip in adapter.ips:
        if ip.is_IPv4:
            print(adapter.nice_name, ip.ip, ip.network_prefix)
EOF
```

Identify the address inside the LAN CIDR from Step 1, then:

```python
python -c "from wakeonlan import send_magic_packet; send_magic_packet('<MAC>', ip_address='<LAN_BROADCAST>', interface='<LAN_IP>')"
```

Expected: **a `udp port 9` packet appears in tcpdump**, and if the television is off, it wakes.

- [ ] **Step 6: Record the outcome**

Write the answer, the LAN CIDR, and the observed interface layout into the "Risks" section of the spec as a resolved item:

```bash
cd /Users/ricardo/synced/Projects/home
$EDITOR docs/superpowers/specs/2026-09-06-remote-role-design.md
git add docs/superpowers/specs/2026-09-06-remote-role-design.md
git commit -m "Record the verified Wake-on-LAN behaviour over ipvlan"
```

**If Step 5 produced no packet: STOP.** Report back rather than proceeding. The fallbacks (a `macvlan` network, or leaving a thin WoL agent on `autopi`) both change the architecture.

---

### Task 2: Rescue the training data off autopi

`/opt/tv/recordings.jsonl` on `autopi` is the live, authoritative copy of the training data — the app has been appending to it. `$TV/model/recordings.jsonl` is a snapshot from an earlier `task download`. Nothing may be decommissioned until the live copy is safe.

**Files:**
- Create: `roles/remote/model/recordings.jsonl` (working copy, gitignored)
- Create: `roles/remote/.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `roles/remote/model/recordings.jsonl`, the input to Task 9.

- [ ] **Step 1: Create the role directory and its gitignore**

```bash
cd /Users/ricardo/synced/Projects/home
mkdir -p roles/remote/model
cat > roles/remote/.gitignore <<'EOF'
/model/logs
/model/out
/model/recordings.jsonl
/static/model
__pycache__
.pytest_cache
EOF
```

- [ ] **Step 2: Pull the live recordings off autopi**

```bash
cd /Users/ricardo/synced/Projects/home
scp autopi:/opt/tv/recordings.jsonl roles/remote/model/recordings.jsonl
```

- [ ] **Step 3: Verify it is intact and at least as complete as the snapshot**

```bash
wc -l roles/remote/model/recordings.jsonl
wc -l /Users/ricardo/synced/Projects/tv/model/recordings.jsonl
python3 -c "
import json,sys
n=0
for line in open('roles/remote/model/recordings.jsonl'):
    line=line.strip()
    if line:
        json.loads(line); n+=1
print('valid lines:', n)
"
```

Expected: every line parses as JSON, and the live count is **>= 3462** (the snapshot's count). If it is lower, the snapshot is newer — investigate before continuing, and keep both.

- [ ] **Step 4: Take a second copy outside the repo**

```bash
cp roles/remote/model/recordings.jsonl ~/Desktop/recordings-autopi-$(date +%Y%m%d).jsonl
```

This survives an accidental `git clean`. Delete it after Task 9 has published the dataset successfully.

- [ ] **Step 5: Commit the gitignore**

```bash
git add roles/remote/.gitignore
git commit -m "Add a gitignore for the remote role"
```

---

### Task 3: Scaffold the role and its test harness

Creates the app's poetry project and proves pytest runs. Nothing TV-specific yet.

**Files:**
- Create: `roles/remote/pyproject.toml`
- Create: `roles/remote/poetry.toml`
- Create: `roles/remote/app/__init__.py`
- Create: `roles/remote/tests/__init__.py`
- Test: `roles/remote/tests/test_smoke.py`
- Create: `roles/remote/static/gestures.json` (copied)
- Create: `roles/remote/static/favicon.png`, `favicon-192.png`, `help.jpg`, `manifest.json`, `remote.svg` (copied)
- Create: `roles/remote/assets/logo.xcf`, `help.xcf` (copied, git-lfs)
- Create: `.gitattributes` at the repo root

**Interfaces:**
- Consumes: nothing.
- Produces: a working `poetry run pytest` inside `roles/remote/` for every later task.

- [ ] **Step 1: Create the poetry manifest**

`roles/remote/pyproject.toml`:

```toml
[tool.poetry]
name = "remote"
version = "0.1.0"
description = "TV gesture remote"
authors = ["Ricardo Matsui"]
package-mode = false

[tool.poetry.dependencies]
python = "^3.13"
flask = "^3.1.0"
gunicorn = "^23.0.0"
websockets = "^13.1"
janus = "^1.1.0"
wakeonlan = "^3.1.0"
ifaddr = "^0.2.0"

[tool.poetry.group.dev.dependencies]
pytest = "^8.3.0"

[build-system]
requires = ["poetry-core>=1.0.0"]
build-backend = "poetry.core.masonry.api"
```

`roles/remote/poetry.toml` (match `$TV/poetry.toml` — keeps the venv in-project):

```toml
[virtualenvs]
in-project = true
```

- [ ] **Step 2: Copy over the static assets and the gesture definitions**

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote
mkdir -p app tests static templates model assets
TV=/Users/ricardo/synced/Projects/tv
cp $TV/tv/gestures.json static/
cp $TV/tv/favicon.png $TV/tv/favicon-192.png $TV/tv/help.jpg $TV/tv/manifest.json static/
cp $TV/assets/tv.svg static/remote.svg
```

`gestures.json` goes to `static/` and is committed. It is the source of truth for all four consumers: record prompts and key dispatch in the browser, the `ClassLabel` order in `publish_dataset.py`, the augmentation flags in `train.py`, and the label vector `publish_model.py` uploads with the weights.

It must ship from git rather than from HuggingFace, and the reason is the recording loop. Adding an eleventh gesture needs training samples for it; samples come from record mode; record mode only prompts for gestures in the file it was served. Served from the model repo, the eleventh gesture could never be recorded, because no model would list it until one had been trained on samples that could not be collected.

Inference has the opposite need — its index → name mapping must be locked to the weights — so it reads a *second* file, `static/model/gestures.json`, which Task 13 downloads from HuggingFace alongside the model. Task 8 wires both up. Because the Dockerfile copies `static/` wholesale, the committed one needs no special handling in the build.

- [ ] **Step 2b: Set up git-lfs and bring the GIMP sources over**

This repository has never used LFS. Set it up *before* adding the files, or they land as plain blobs and rewriting that is a nuisance.

```bash
cd /Users/ricardo/synced/Projects/home
git lfs install
printf '*.xcf filter=lfs diff=lfs merge=lfs -text\n' > .gitattributes
git add .gitattributes
git commit -m "Track GIMP sources with git-lfs"

cp /Users/ricardo/synced/Projects/tv/assets/logo.xcf roles/remote/assets/
cp /Users/ricardo/synced/Projects/tv/assets/help.xcf roles/remote/assets/
git add roles/remote/assets
git commit -m "Add the remote design sources"
```

The attributes are committed first, in their own commit, so the `.xcf` files are already matched by the filter when they are staged.

Verify they are pointers, not blobs:

```bash
git lfs ls-files
git show HEAD:roles/remote/assets/logo.xcf | head -3
```

Expected: both `.xcf` files listed, and `git show` prints a `version https://git-lfs.github.com/spec/v1` pointer rather than binary. If it prints binary, the filter did not apply — `git rm --cached` the files and re-add them.

Then confirm Gitea serves LFS for this repository the way it already does for `tv`:

```bash
git push
git clone <origin> /tmp/home-lfs-check
file /tmp/home-lfs-check/roles/remote/assets/logo.xcf
rm -rf /tmp/home-lfs-check
```

Expected: `GIMP XCF image data`, not ASCII text. Task 14 adds the git-lfs prerequisite to `README.md`; anyone cloning `home` now needs it installed.

- [ ] **Step 3: Create empty package markers**

```bash
touch app/__init__.py tests/__init__.py
```

- [ ] **Step 4: Write a smoke test**

`roles/remote/tests/test_smoke.py`:

```python
import json
from pathlib import Path


def test_gestures_json_is_loadable_and_ordered():
    gestures = json.loads(
        (Path(__file__).parent.parent / 'static' / 'gestures.json').read_text()
    )

    assert [gesture['name'] for gesture in gestures] == [
        'up',
        'down',
        'left',
        'right',
        'circle',
        'counterCircle',
        'n',
        'p',
        'v',
        '^',
    ]
    assert all('action' in gesture for gesture in gestures)
```

This is not a throwaway smoke test: it pins the label order, which is the contract the dataset and the model both depend on. The authoritative check on the publishing side, which also compares against the published dataset's `ClassLabel` names and the model card, is `model/tests/test_labels.py` in Task 9. The browser side is enforced at page load by the guards in Task 8.

- [ ] **Step 5: Install and run**

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote
poetry install
poetry run pytest -v
```

Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
cd /Users/ricardo/synced/Projects/home
git add roles/remote
git commit -m "Scaffold the remote role with its assets and test harness"
```

---

### Task 4: LAN interface selection

The pure function behind correct WoL egress. Written first because it is the part most likely to be got wrong and the easiest to test.

**Files:**
- Create: `roles/remote/app/network.py`
- Test: `roles/remote/tests/test_network.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `LanInterface` — frozen dataclass with `source_ip: str` and `broadcast_ip: str`.
  - `LanInterfaceNotFound(Exception)`.
  - `select_lan_interface(addresses: list[str], lan_cidr: str) -> LanInterface` — pure; `addresses` are IPv4 addresses in CIDR form such as `'10.0.1.42/24'`.
  - `local_addresses() -> list[str]` — impure adapter enumerating the container's IPv4 addresses in the same CIDR form.

- [ ] **Step 1: Write the failing tests**

`roles/remote/tests/test_network.py`:

```python
import pytest

from app.network import (
    LanInterface,
    LanInterfaceNotFound,
    select_lan_interface,
)


def test_selects_the_address_inside_the_lan_cidr():
    result = select_lan_interface(['10.0.1.42/24'], '10.0.1.0/24')

    assert result == LanInterface(source_ip='10.0.1.42', broadcast_ip='10.0.1.255')


def test_ignores_the_overlay_address_and_picks_the_lan_one():
    result = select_lan_interface(
        ['127.0.0.1/8', '10.0.9.3/24', '172.18.0.5/16', '10.0.1.42/24'],
        '10.0.1.0/24',
    )

    assert result.source_ip == '10.0.1.42'


def test_derives_the_broadcast_from_the_configured_cidr_not_the_address():
    result = select_lan_interface(['192.168.4.7/32'], '192.168.4.0/22')

    assert result.broadcast_ip == '192.168.7.255'


def test_raises_when_no_address_is_on_the_lan():
    with pytest.raises(LanInterfaceNotFound) as error:
        select_lan_interface(['172.18.0.5/16'], '10.0.1.0/24')

    assert '10.0.1.0/24' in str(error.value)
    assert '172.18.0.5/16' in str(error.value)


def test_raises_when_there_are_no_addresses_at_all():
    with pytest.raises(LanInterfaceNotFound):
        select_lan_interface([], '10.0.1.0/24')
```

The third test is the one that matters most: the broadcast must come from the *configured* network, not from the interface's own prefix, because Docker may hand the container a `/32` on the ipvlan network.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote
poetry run pytest tests/test_network.py -v
```

Expected: FAIL, `ModuleNotFoundError: No module named 'app.network'`.

- [ ] **Step 3: Write the implementation**

`roles/remote/app/network.py`:

```python
import ipaddress
from dataclasses import dataclass

import ifaddr


@dataclass(frozen=True)
class LanInterface:
    source_ip: str
    broadcast_ip: str


class LanInterfaceNotFound(Exception):
    pass


def select_lan_interface(addresses, lan_cidr):
    network = ipaddress.ip_network(lan_cidr, strict=False)

    for address in addresses:
        if ipaddress.ip_interface(address).ip in network:
            return LanInterface(
                source_ip=str(ipaddress.ip_interface(address).ip),
                broadcast_ip=str(network.broadcast_address),
            )

    raise LanInterfaceNotFound(
        f'no interface address within {lan_cidr}; saw {addresses}'
    )


def local_addresses():
    return [
        f'{ip.ip}/{ip.network_prefix}'
        for adapter in ifaddr.get_adapters()
        for ip in adapter.ips
        if ip.is_IPv4
    ]
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
poetry run pytest tests/test_network.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/ricardo/synced/Projects/home
git add roles/remote/app/network.py roles/remote/tests/test_network.py
git commit -m "Select the LAN interface for Wake-on-LAN broadcasts"
```

---

### Task 5: The recordings store

Extracts the `/record` and `/delete` file handling out of the route layer, and fixes a latent crash: `$TV/tv/tv.py:564` opens `recordings.jsonl` for reading unconditionally, so pressing Delete before anything has been recorded raises `FileNotFoundError` and returns a 500.

**Files:**
- Create: `roles/remote/app/recordings.py`
- Test: `roles/remote/tests/test_recordings.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Recordings(path: pathlib.Path)`.
  - `Recordings.append(gesture: str, image: str) -> None`.
  - `Recordings.delete_last() -> bool` — `True` if a line was removed, `False` if there was nothing to remove.

- [ ] **Step 1: Write the failing tests**

`roles/remote/tests/test_recordings.py`:

```python
import json

from app.recordings import Recordings


def test_append_writes_one_json_line(tmp_path):
    recordings = Recordings(tmp_path / 'recordings.jsonl')

    recordings.append('circle', 'data:image/png;base64,AAAA')

    lines = (tmp_path / 'recordings.jsonl').read_text().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0]) == {
        'gesture': 'circle',
        'image': 'data:image/png;base64,AAAA',
    }


def test_append_creates_the_parent_directory(tmp_path):
    recordings = Recordings(tmp_path / 'data' / 'recordings.jsonl')

    recordings.append('up', 'data:image/png;base64,AAAA')

    assert (tmp_path / 'data' / 'recordings.jsonl').exists()


def test_delete_last_removes_only_the_final_line(tmp_path):
    recordings = Recordings(tmp_path / 'recordings.jsonl')
    recordings.append('up', 'a')
    recordings.append('down', 'b')

    assert recordings.delete_last() is True

    lines = (tmp_path / 'recordings.jsonl').read_text().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])['gesture'] == 'up'


def test_delete_last_on_a_missing_file_returns_false(tmp_path):
    recordings = Recordings(tmp_path / 'recordings.jsonl')

    assert recordings.delete_last() is False


def test_delete_last_on_an_empty_file_returns_false(tmp_path):
    path = tmp_path / 'recordings.jsonl'
    path.write_text('')

    assert Recordings(path).delete_last() is False


def test_append_then_delete_is_a_round_trip(tmp_path):
    recordings = Recordings(tmp_path / 'recordings.jsonl')
    recordings.append('up', 'a')
    recordings.delete_last()

    assert (tmp_path / 'recordings.jsonl').read_text() == ''
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote
poetry run pytest tests/test_recordings.py -v
```

Expected: FAIL, `ModuleNotFoundError: No module named 'app.recordings'`.

- [ ] **Step 3: Write the implementation**

`roles/remote/app/recordings.py`:

```python
import json


class Recordings:
    def __init__(self, path):
        self.path = path

    def append(self, gesture, image):
        self.path.parent.mkdir(parents=True, exist_ok=True)

        with self.path.open('a') as file:
            file.write(json.dumps(dict(gesture=gesture, image=image)) + '\n')

    def delete_last(self):
        if not self.path.exists():
            return False

        lines = self.path.read_text().splitlines(keepends=True)

        if not lines:
            return False

        self.path.write_text(''.join(lines[:-1]))
        return True
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
poetry run pytest tests/test_recordings.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/ricardo/synced/Projects/home
git add roles/remote/app/recordings.py roles/remote/tests/test_recordings.py
git commit -m "Store gesture recordings without crashing on an empty log"
```

---

### Task 6: The television control worker

A near-verbatim port of `$TV/tv/tv.py:27-101` — the asyncio websocket worker, its pending-message queue, and the WoL fallback — wrapped in a class so it is constructed explicitly rather than at import time via module-level globals, and using Task 4 for the broadcast address.

**Read `$TV/tv/tv.py:27-101` before starting.** The retry semantics are subtle and must be preserved exactly: a failed send sets `last_attempt_failed`, which causes the *next* queued `powerOn` to be dropped (because the WoL packet just sent will already have woken the television, and a second `KEY_POWER` would turn it back off).

**Files:**
- Create: `roles/remote/app/control.py`

**Interfaces:**
- Consumes: `app.network.select_lan_interface`, `app.network.local_addresses`.
- Produces:
  - `TvControl(ip: str, mac: str, token: str, lan_cidr: str)`.
  - `TvControl.start() -> None` — starts the daemon thread and blocks until the queue exists.
  - `TvControl.send(message: dict) -> None` — enqueues; never blocks on the television.

- [ ] **Step 1: Write the implementation**

`roles/remote/app/control.py`:

```python
import asyncio
import base64
import json
import logging
import queue
import ssl
import threading

import janus
import websockets
from wakeonlan import send_magic_packet

from app.network import local_addresses, select_lan_interface

logger = logging.getLogger(__name__)

# The Samsung pairing token is bound to this client name. Changing it
# invalidates the token and makes the television re-prompt for pairing.
CLIENT_NAME = 'NodeJS-Test'


class TvControl:
    def __init__(self, ip, mac, token, lan_cidr):
        self.ip = ip
        self.mac = mac
        self.token = token
        self.lan = select_lan_interface(local_addresses(), lan_cidr)
        self.message_queue = None

        logger.debug(
            'wol will use source %s broadcast %s',
            self.lan.source_ip,
            self.lan.broadcast_ip,
        )

    def start(self):
        handoff = queue.Queue()

        thread = threading.Thread(
            target=lambda: asyncio.run(self._process_messages(handoff)),
            daemon=True,
        )
        thread.start()

        self.message_queue = handoff.get()

    def send(self, message):
        self.message_queue.sync_q.put(message)

    def _wake(self):
        send_magic_packet(
            self.mac,
            ip_address=self.lan.broadcast_ip,
            interface=self.lan.source_ip,
        )
        logger.debug('-> wol')

    def _url(self):
        name = base64.b64encode(CLIENT_NAME.encode('utf-8')).decode('utf-8')
        return (
            f'wss://{self.ip}:8002/api/v2/channels/samsung.remote.control'
            f'?name={name}&token={self.token}'
        )

    async def _process_messages(self, handoff):
        message_queue = janus.Queue()
        handoff.put(message_queue)

        pending = []
        last_attempt_failed = False

        while True:
            if len(pending) == 0:
                pending.append(await message_queue.async_q.get())

            ssl_context = ssl.SSLContext()
            ssl_context.verify_mode = ssl.CERT_NONE

            try:
                async with websockets.connect(
                    self._url(),
                    ssl=ssl_context,
                    open_timeout=2,
                    ping_interval=5,
                    ping_timeout=2,
                    close_timeout=2,
                ) as websocket:
                    while len(pending) > 0:
                        if last_attempt_failed and pending[0]['kind'] == 'powerOn':
                            pending.pop(0)
                            logger.debug('! skipping powerOn')
                        else:
                            await websocket.send(json.dumps(pending[0]['data']))
                            pending.pop(0)
                            logger.debug('-> sent')

                        last_attempt_failed = False

                        while True:
                            next_message_task = asyncio.create_task(
                                message_queue.async_q.get()
                            )
                            recv_task = asyncio.create_task(websocket.recv())

                            done, incomplete = await asyncio.wait(
                                [next_message_task, recv_task],
                                timeout=3600,
                                return_when=asyncio.FIRST_COMPLETED,
                            )

                            if next_message_task in done:
                                logger.debug('next message done')
                                pending.append(next_message_task.result())
                            else:
                                logger.debug('next message cancel')
                                next_message_task.cancel()

                            if recv_task in done:
                                logger.debug('<- recv: %s', recv_task.result())
                            else:
                                recv_task.cancel()

                            if len(done) == 0 or next_message_task in done:
                                logger.debug('exiting')
                                break
            except Exception as error:
                logger.debug('<- error %s', error)

                if len(pending) > 0:
                    last_attempt_failed = True
                    self._wake()
```

- [ ] **Step 2: Diff it against the original to confirm the port is faithful**

```bash
sed -n '27,101p' /Users/ricardo/synced/Projects/tv/tv/tv.py > /tmp/original-worker.py
$EDITOR -d /tmp/original-worker.py roles/remote/app/control.py
```

Confirm the only differences are: `app.logger` → `logger`, `CONFIG[...]` → `self....`, the module-level `queue_queue` → the local `handoff`, and `wakeonlan.send_magic_packet(mac)` → `self._wake()`. The control flow must be identical.

- [ ] **Step 3: Confirm nothing broke**

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote
poetry run python -c "import app.control"
poetry run pytest -v
```

Expected: import succeeds, all previous tests still pass.

The worker itself is not unit-tested — it is verified against the real television in Task 15, as it is today.

- [ ] **Step 4: Commit**

```bash
cd /Users/ricardo/synced/Projects/home
git add roles/remote/app/control.py
git commit -m "Port the television control worker into the remote role"
```

---

### Task 7: The Flask app and its routes

**Files:**
- Create: `roles/remote/app/__init__.py` (replacing the empty marker)
- Test: `roles/remote/tests/test_routes.py`

**Interfaces:**
- Consumes: `app.recordings.Recordings`, `app.control.TvControl`.
- Produces: `create_app(control=None, recordings=None, static=None) -> flask.Flask`. `control` and `recordings` exist so tests can inject fakes; when omitted, the app builds real ones from the environment (`REMOTE_TV_IP`, `REMOTE_TV_MAC`, `REMOTE_TV_TOKEN`, `REMOTE_LAN_CIDR`, `RECORDINGS_PATH`). `static` overrides the directory the custom file routes read from, so the suite never touches the role's own `static/` — see the fixtures in Step 1. Flask's own static endpoint is left alone; only the hand-written routes honour it.

- [ ] **Step 1: Write the failing tests**

`roles/remote/tests/test_routes.py`:

```python
import json
import shutil
from pathlib import Path

import pytest

from app import create_app
from app.recordings import Recordings


class FakeControl:
    def __init__(self):
        self.sent = []

    def send(self, message):
        self.sent.append(message)


@pytest.fixture
def control():
    return FakeControl()


@pytest.fixture
def static_root(tmp_path):
    """An isolated copy of static/, so tests never touch real build inputs.

    static/model/ is excluded: it is the Ansible fetch's output, and after a
    deploy it holds real weights. A fixture that wrote into the role's own
    static/model/ would clobber them, and its teardown would delete them.
    Tests that need a fetched model use the fetched_model fixture.
    """
    root = tmp_path / 'static'
    shutil.copytree(
        Path(__file__).parent.parent / 'static',
        root,
        ignore=shutil.ignore_patterns('model'),
    )
    return root


@pytest.fixture
def fetched_model(static_root):
    """Simulates the Ansible fetch having run.

    The label vector is seeded from the committed roster, which is what a
    freshly trained model would have been published with.
    """
    directory = static_root / 'model'
    directory.mkdir()
    (directory / 'gestures.json').write_text(
        (static_root / 'gestures.json').read_text()
    )
    (directory / 'model.json').write_text('{"format": "layers-model"}')
    return directory


@pytest.fixture
def client(control, static_root, tmp_path):
    app = create_app(
        control=control,
        recordings=Recordings(tmp_path / 'recordings.jsonl'),
        static=static_root,
    )
    app.config['TESTING'] = True
    return app.test_client()


def test_index_renders(client):
    response = client.get('/')

    assert response.status_code == 200
    assert b'debug-canvas' in response.data


def test_the_roster_is_served_without_caching(client):
    """The roster is committed, so it is served with no fixture."""
    response = client.get('/gestures.json')

    assert response.status_code == 200
    assert response.cache_control.no_cache
    assert json.loads(response.data)[0]['name'] == 'up'


def test_the_label_vector_is_served_from_the_fetched_model(client, fetched_model):
    response = client.get('/model/gestures.json')

    assert response.status_code == 200
    assert response.cache_control.no_cache
    assert json.loads(response.data)[0]['name'] == 'up'


def test_the_label_vector_404s_when_the_model_has_not_been_fetched(client):
    """A build that skipped the Ansible fetch must fail visibly, not serve
    the roster as though it were the model's label vector."""
    response = client.get('/model/gestures.json')

    assert response.status_code == 404


def test_control_enqueues_the_parsed_message(client, control):
    message = {'kind': 'up', 'data': {'method': 'ms.remote.control'}}

    response = client.post('/control', data={'message': json.dumps(message)})

    assert response.status_code == 204
    assert control.sent == [message]


def test_record_appends_a_recording(client, tmp_path):
    response = client.post(
        '/record',
        data={'gesture': 'circle', 'image': 'data:image/png;base64,AAAA'},
    )

    assert response.status_code == 204
    assert json.loads(
        (tmp_path / 'recordings.jsonl').read_text().splitlines()[0]
    )['gesture'] == 'circle'


def test_delete_on_an_empty_log_still_returns_204(client):
    response = client.post('/delete')

    assert response.status_code == 204


def test_manifest_is_served_from_the_root(client):
    response = client.get('/manifest.json')

    assert response.status_code == 200
    assert json.loads(response.data)['short_name'] == 'TV'


def test_model_files_are_served_without_caching(client, fetched_model):
    response = client.get('/model/model.json')

    assert response.status_code == 200
    assert response.cache_control.no_cache


def test_a_missing_model_file_is_a_404(client):
    response = client.get('/model/nope.json')

    assert response.status_code == 404
```

Both use the `fetched_model` fixture defined at the top of the file; no extra fixture is needed.

**Every fixture here is hermetic on purpose.** `create_app` takes a `static` root so the suite runs against a `tmp_path` copy, never the role's own `static/`. That matters from Task 12 onwards: once the Ansible fetch (or Task 12 Step 6's manual fetch) has populated `static/model/` with real weights, a fixture that wrote there would clobber them and its teardown would delete them. It also keeps `test_the_label_vector_404s_when_the_model_has_not_been_fetched` meaningful — it asserts a 404 by simply not requesting `fetched_model`, rather than by depending on the checkout being pristine.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote
poetry run pytest tests/test_routes.py -v
```

Expected: FAIL, `ImportError: cannot import name 'create_app'`.

- [ ] **Step 3: Write the implementation**

`roles/remote/app/__init__.py`:

```python
import json
import logging
import os
from pathlib import Path

import flask

from app.control import TvControl
from app.recordings import Recordings

ROOT = Path(__file__).parent.parent


def create_app(control=None, recordings=None, static=None):
    logging.basicConfig(format='%(message)s', level=logging.DEBUG)

    app = flask.Flask(__name__, root_path=str(ROOT))
    app.logger.setLevel(logging.DEBUG)

    if recordings is None:
        recordings = Recordings(
            Path(os.environ.get('RECORDINGS_PATH', '/data/recordings.jsonl'))
        )

    if control is None:
        control = TvControl(
            ip=os.environ['REMOTE_TV_IP'],
            mac=os.environ['REMOTE_TV_MAC'],
            token=os.environ['REMOTE_TV_TOKEN'],
            lan_cidr=os.environ['REMOTE_LAN_CIDR'],
        )
        control.start()

    # Tests pass an isolated static root; production uses Flask's own.
    static = Path(static) if static else Path(app.static_folder)

    @app.route('/')
    def index():
        return flask.render_template('index.html')

    @app.route('/control', methods=['POST'])
    def post_control():
        message = json.loads(flask.request.form.get('message'))
        app.logger.debug('= control: %s', json.dumps(message))
        control.send(message)
        return flask.Response(status=204)

    @app.route('/record', methods=['POST'])
    def post_record():
        recordings.append(
            flask.request.form.get('gesture'),
            flask.request.form.get('image'),
        )
        return flask.Response(status=204)

    @app.route('/delete', methods=['POST'])
    def post_delete():
        recordings.delete_last()
        return flask.Response(status=204)

    # The roster: what record mode prompts for and what each name does.
    # Committed, so a new gesture is recordable before any model knows it
    # exists. The label vector inference uses is a different file, served
    # by the /model/ route below as /model/gestures.json.
    @app.route('/gestures.json')
    def gestures_json():
        response = flask.make_response(flask.send_file(static / 'gestures.json'))
        response.cache_control.max_age = None
        response.cache_control.no_cache = True
        return response

    @app.route('/model/<path:filename>')
    def model(filename):
        response = flask.make_response(
            flask.send_from_directory(static / 'model', filename)
        )
        response.cache_control.max_age = None
        response.cache_control.no_cache = True
        return response

    @app.route('/favicon.png')
    def favicon():
        return flask.send_from_directory(static, 'favicon.png')

    @app.route('/favicon-192.png')
    def favicon192():
        return flask.send_from_directory(static, 'favicon-192.png')

    @app.route('/help.jpg')
    def help_image():
        return flask.send_from_directory(static, 'help.jpg')

    @app.route('/manifest.json')
    def manifest():
        return flask.send_from_directory(static, 'manifest.json')

    return app
```

Note `send_from_directory` is what makes the traversal test pass — it rejects paths that escape the directory, which the original `flask.send_from_directory('model', ...)` also did. The test exists to keep it that way.

- [ ] **Step 4: Create a placeholder template so the index test can pass**

Task 8 writes the real one. For now, `roles/remote/templates/index.html`:

```html
<!doctype html>
<html><body><canvas class='debug-canvas'></canvas></body></html>
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
poetry run pytest -v
```

Expected: all tests pass, 7 of them from `test_routes.py`.

- [ ] **Step 6: Commit**

```bash
cd /Users/ricardo/synced/Projects/home
git add roles/remote/app/__init__.py roles/remote/tests/test_routes.py roles/remote/templates/index.html
git commit -m "Serve the remote app from a Flask factory"
```

---

### Task 8: Split the frontend out of the Python source

`$TV/tv/tv.py:106-543` is a single `render_template_string` call containing the whole page. It moves out **verbatim except for four specified changes**. Extract rather than retype — the gesture pipeline is fiddly and a transcription slip would be very hard to spot.

**Files:**
- Modify: `roles/remote/templates/index.html` (replace the placeholder)
- Create: `roles/remote/static/styles.css`
- Create: `roles/remote/static/app.js`

**Interfaces:**
- Consumes: the routes from Task 7.
- Produces: the served page. No JS module boundary — `app.js` stays a single `type='module'` script, as today.

- [ ] **Step 1: Extract the three pieces mechanically**

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote
TV=/Users/ricardo/synced/Projects/tv/tv/tv.py

# CSS: the body of <style>, lines 117-140
sed -n '117,140p' $TV | sed 's/^                    //' > static/styles.css

# JS: the body of the module script, lines 166-539
sed -n '166,539p' $TV | sed 's/^                    //' > static/app.js

# HTML: head + body markup, lines 107-162
sed -n '107,162p' $TV | sed 's/^        //' > /tmp/index-markup.html
```

- [ ] **Step 2: Assemble the template**

`roles/remote/templates/index.html` — take `/tmp/index-markup.html` and make exactly these edits:

1. Replace the inline `<style> … </style>` block (originally lines 116-141) with:

   ```html
   <link rel='stylesheet' href="{{ url_for('static', filename='styles.css') }}">
   ```

2. Drop the htmx `<script src=…>` tag (originally line 163) entirely, and leave the tfjs one (line 164) as a CDN load, pinned to the version that matches the converter recorded on the model card:

   ```html
   <script src='https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js'></script>
   ```

   Note this URL is not byte-identical to the original, which was the bare `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0`. jsdelivr resolves that to `dist/tf.min.js` via the package's `jsdelivr` field, so both fetch the same artifact today. Naming the file explicitly is the one deliberate deviation from "no behaviour changes" in the port: it pins the artifact rather than trusting a package.json default to stay put, which serves the same goal the constraint exists for — making a regression attributable.

   tfjs is deliberately *not* vendored into the image. The trade-off is that a WAN outage, with the page not already in the browser cache, means no inference on a remote that would otherwise still work on the LAN. Vendoring is a small change to make later if it ever bites.

3. Replace the opening `<script type='module'>` and its closing `</script>` (originally lines 165 and 540) with:

   ```html
   <script type='module' src="{{ url_for('static', filename='app.js') }}"></script>
   ```

4. Leave everything else — the two vertical rule divs, the bottom bar, the button/checkbox row, and `.debug-canvas` — byte-identical.

- [ ] **Step 3: Replace htmx in `static/app.js`**

Add this helper at the top of `static/app.js`:

```javascript
const post = (url, values = {}) =>
    fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values),
    });
```

`URLSearchParams` with that content type produces exactly the form encoding `flask.request.form.get()` reads, so no server change is needed.

Then rewrite the four call sites (originally `$TV/tv/tv.py` lines 197, 360, 478, 536):

```javascript
// was: htmx.ajax('POST', '/delete').then(() => {
post('/delete').then(() => {

// was: htmx.ajax('POST', '/record', { values: { gesture: …, image: … } });
post('/record', {
    gesture: gestures[recordingGestureIndex].name,
    image: imageUrl,
});

// was: htmx.ajax('POST', '/control', { values: { message: JSON.stringify(message) } });
// (both remaining sites, identical shape)
post('/control', { message: JSON.stringify(message) });
```

Verify none remain:

```bash
grep -n htmx static/app.js templates/index.html
```

Expected: no output.

- [ ] **Step 3b: Split the roster from the label vector**

This is the one behavioural change in the port, and the reason is in the spec's "The label contract": the roster has to run ahead of the model so a new gesture can be recorded before one has been trained on it, while inference has to be locked to the weights.

Replace the single fetch (originally `$TV/tv/tv.py` line 166):

```javascript
// was: const gestures = await (await fetch('gestures.json')).json();

// Two files, two jobs.
//   gestures.json        - the roster. Committed, so a new gesture is
//                          recordable before any model knows it exists.
//   /model/gestures.json - this model's output index -> name. Published
//                          with the weights, so it cannot drift from them.
const roster = await (await fetch('gestures.json')).json();
const labels = await (await fetch('/model/gestures.json')).json();

const actions = new Map(roster.map((gesture) => [gesture.name, gesture]));
```

Add the load-time guards immediately after `tf.loadLayersModel` returns:

```javascript
if (labels.length !== model.outputs[0].shape[1]) {
    throw new Error(
        `model has ${model.outputs[0].shape[1]} outputs but `
        + `${labels.length} labels were published alongside it`
    );
}

const orphans = labels.filter((label) => !actions.has(label.name));
if (orphans.length) {
    throw new Error(
        'model predicts classes with no action: '
        + orphans.map((label) => label.name).join(', ')
    );
}
```

The asymmetry is deliberate. `roster` may hold names `labels` does not — those are gestures pending training, and that is the normal state mid-loop. A label with no action is fatal, and failing at page load beats mis-dispatching on the first gesture.

Then rename the recording sites (originally lines 205, 206, 213, 216, 220, 224, 362) from `gestures` to `roster` — record mode picks from the roster, so this is a pure rename:

```javascript
let recordingGestureIndex = Math.floor(Math.random() * roster.length);
// ...
recordInstructions.innerText = roster[recordingGestureIndex].name.padStart(15)
    + ', ' + roster[nextRecordingGestureIndex].name.padStart(15);
// ...
gesture: roster[recordingGestureIndex].name,
```

And change the one inference site (originally line 398) to go through the labels and look the action up **by name**:

```javascript
// was: const gesture = gestures[result.index];
const gesture = actions.get(labels[result.index].name);
```

That last line is the substantive part. `gestures[result.index]` had one array index answering two questions — which class did the model predict, and what should happen as a result. The `0.6` confidence check above it is untouched.

Verify no site still indexes the wrong array:

```bash
grep -n 'gestures\[' static/app.js
grep -n 'roster\[result\|labels\[recording' static/app.js
```

Expected: no output from either. The first catches a missed rename; the second catches the two arrays being swapped at a use site.

- [ ] **Step 4: Confirm nothing else changed**

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote
grep -c "" static/app.js          # expect ~374 lines +5 for the helper
grep -n "0.6" static/app.js        # the confidence threshold must still be there
grep -n "hsl(0, 0%" static/app.js  # the direction-encoding ramp must still be there
grep -n "loadLayersModel" static/app.js
```

The `loadLayersModel` call must still read `tf.loadLayersModel('/model/model.json')` — the route from Task 7 serves it, and tfjs resolves the weight shard relative to that URL.

- [ ] **Step 5: Update the index test now that the real template is in place**

In `roles/remote/tests/test_routes.py`, extend `test_index_renders`:

```python
def test_index_renders(client):
    response = client.get('/')

    assert response.status_code == 200
    assert b'debug-canvas' in response.data
    assert b'/static/app.js' in response.data
    assert b'/static/styles.css' in response.data
    assert b'unpkg.com' not in response.data
    assert b'@tensorflow/tfjs@4.20.0' in response.data
```

Note this test asserts on the template only. The roster/label-vector split lives in `app.js` and is enforced in the browser at load time, not by pytest — the guards in Step 3b are the test for it. `test_routes.py` covers that both files are *served*; nothing on the Python side can check that `app.js` reads the right one.

The `unpkg.com` assertion is the regression guard for dropping htmx. The pinned-version assertion is the guard for risk 4 in the spec: the tfjs runtime version now lives in a template rather than a build arg, which makes it easy to drift away from the tfjs-converter version that produced the weights. If you bump the converter in Task 10, this assertion is what reminds you to bump the template too.

- [ ] **Step 6: Run the tests**

```bash
poetry run pytest -v
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/ricardo/synced/Projects/home
git add roles/remote/templates roles/remote/static roles/remote/tests/test_routes.py
git commit -m "Split the remote page into a template, stylesheet, and script"
```

---

### Task 9: Publish the dataset to HuggingFace

**Files:**
- Create: `roles/remote/model/pyproject.toml`
- Create: `roles/remote/model/poetry.toml`
- Create: `roles/remote/model/publish_dataset.py`
- Create: `roles/remote/model/cards/dataset_card.md`
- Create: `roles/remote/model/tests/__init__.py`
- Test: `roles/remote/model/tests/test_publish_dataset.py`

**Interfaces:**
- Consumes: `roles/remote/static/gestures.json`, `roles/remote/model/recordings.jsonl` (Task 2).
- Produces:
  - `load_gesture_names(path) -> list[str]` — the label order.
  - `build_dataset(recordings_path, gesture_names) -> datasets.Dataset` with features `{image: Image, label: ClassLabel(names=gesture_names)}`.
  - The published dataset `{hf-user}/remote-gestures`, which Task 10 loads.

- [ ] **Step 1: Confirm the HuggingFace namespace and log in**

```bash
huggingface-cli whoami
```

If this is not the intended account, `huggingface-cli login` first. **Renaming a HF repo later breaks the pinned revision URLs in the Dockerfile**, so settle the namespace now. Everything below assumes `ricmatsui`; substitute if different, consistently, in this task, Task 11, and Task 12.

- [ ] **Step 2: Create the model poetry project**

`roles/remote/model/pyproject.toml` — the TensorFlow pins are carried over unchanged from `$TV/model/pyproject.toml`:

```toml
[tool.poetry]
name = "remote-model"
version = "0.1.0"
description = "Gesture model training and publishing"
authors = ["Ricardo Matsui"]
package-mode = false

[tool.poetry.dependencies]
python = "^3.9"
tensorflow = "2.17.0"
tensorflowjs = "^4.22.0"
numpy = "^1.23.5"
pillow = ">=10.0,<11"
setuptools = "69.5.1"
datasets = "^3.0.0"
huggingface-hub = "^0.25.0"

[tool.poetry.group.dev.dependencies]
pytest = "^8.3.0"

[build-system]
requires = ["poetry-core>=1.0.0"]
build-backend = "poetry.core.masonry.api"
```

`roles/remote/model/poetry.toml`:

```toml
[virtualenvs]
in-project = true
```

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote/model
mkdir -p tests cards
touch tests/__init__.py
poetry install
```

- [ ] **Step 3: Write the failing tests**

`roles/remote/model/tests/test_publish_dataset.py`:

```python
import base64
import io
import json

import pytest
from PIL import Image

from publish_dataset import build_dataset, load_gesture_names

GESTURE_NAMES = ['up', 'down', 'circle']


def encoded_image(shade=128):
    image = Image.new('L', (32, 32), shade)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(
        buffer.getvalue()
    ).decode('utf-8')


def write_recordings(path, rows):
    path.write_text(
        ''.join(json.dumps(row) + '\n' for row in rows)
    )


def test_load_gesture_names_preserves_file_order(tmp_path):
    path = tmp_path / 'gestures.json'
    path.write_text(json.dumps([
        {'name': 'up', 'action': 'up'},
        {'name': 'down', 'action': 'down'},
    ]))

    assert load_gesture_names(path) == ['up', 'down']


def test_build_dataset_round_trips_label_and_image(tmp_path):
    path = tmp_path / 'recordings.jsonl'
    write_recordings(path, [{'gesture': 'circle', 'image': encoded_image()}])

    dataset = build_dataset(path, GESTURE_NAMES)

    assert len(dataset) == 1
    assert dataset.features['label'].names == GESTURE_NAMES
    assert dataset[0]['label'] == GESTURE_NAMES.index('circle')
    assert dataset[0]['image'].size == (32, 32)
    assert dataset[0]['image'].mode == 'L'


def test_build_dataset_rejects_an_unknown_gesture(tmp_path):
    path = tmp_path / 'recordings.jsonl'
    write_recordings(path, [{'gesture': 'spiral', 'image': encoded_image()}])

    with pytest.raises(ValueError) as error:
        build_dataset(path, GESTURE_NAMES)

    assert 'spiral' in str(error.value)


def test_build_dataset_skips_blank_lines(tmp_path):
    path = tmp_path / 'recordings.jsonl'
    path.write_text(
        json.dumps({'gesture': 'up', 'image': encoded_image()}) + '\n\n\n'
    )

    assert len(build_dataset(path, GESTURE_NAMES)) == 1
```

Rejecting an unknown gesture rather than dropping it matters: silently dropping rows would shrink the dataset invisibly if a gesture is ever renamed.

- [ ] **Step 4: Run the tests to verify they fail**

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote/model
poetry run pytest tests/ -v
```

Expected: FAIL, `ModuleNotFoundError: No module named 'publish_dataset'`.

- [ ] **Step 5: Write the implementation**

`roles/remote/model/publish_dataset.py`:

```python
import argparse
import base64
import io
import json
from pathlib import Path

from datasets import ClassLabel, Dataset, Features, Image as ImageFeature
from huggingface_hub import HfApi
from PIL import Image

ROOT = Path(__file__).parent
REPO_ID = 'ricmatsui/remote-gestures'


def load_gesture_names(path):
    return [gesture['name'] for gesture in json.loads(Path(path).read_text())]


def build_dataset(recordings_path, gesture_names):
    images = []
    labels = []

    for line in Path(recordings_path).read_text().splitlines():
        line = line.strip()

        if not line:
            continue

        row = json.loads(line)

        if row['gesture'] not in gesture_names:
            raise ValueError(
                f"unknown gesture {row['gesture']!r}; "
                f'known gestures are {gesture_names}'
            )

        images.append(
            Image.open(
                io.BytesIO(base64.b64decode(row['image'].split(',', 1)[1]))
            ).convert('L')
        )
        labels.append(gesture_names.index(row['gesture']))

    return Dataset.from_dict(
        {'image': images, 'label': labels},
        features=Features({
            'image': ImageFeature(),
            'label': ClassLabel(names=gesture_names),
        }),
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--recordings', default=ROOT / 'recordings.jsonl')
    parser.add_argument('--gestures', default=ROOT.parent / 'static' / 'gestures.json')
    parser.add_argument('--repo-id', default=REPO_ID)
    parser.add_argument('--dry-run', action='store_true')
    arguments = parser.parse_args()

    gesture_names = load_gesture_names(arguments.gestures)
    dataset = build_dataset(arguments.recordings, gesture_names)

    print(f'{len(dataset)} samples')
    for index, name in enumerate(gesture_names):
        count = sum(1 for label in dataset['label'] if label == index)
        print(f'  {name:>15}  {count}')

    if arguments.dry_run:
        return

    dataset.push_to_hub(arguments.repo_id, private=False)

    HfApi().upload_file(
        path_or_fileobj=ROOT / 'cards' / 'dataset_card.md',
        path_in_repo='README.md',
        repo_id=arguments.repo_id,
        repo_type='dataset',
        commit_message='Update the dataset card',
    )

    print(f'https://huggingface.co/datasets/{arguments.repo_id}')


if __name__ == '__main__':
    main()
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
poetry run pytest tests/ -v
```

Expected: 4 passed.

- [ ] **Step 7: Write the dataset card**

`roles/remote/model/cards/dataset_card.md`:

```markdown
---
license: cc-by-4.0
task_categories:
  - image-classification
tags:
  - gesture-recognition
  - touch
size_categories:
  - 1K<n<10K
---

# TV Gestures

Single-stroke touch gestures for a television remote, captured on a phone and
rasterised to 32×32 greyscale images. Ten classes: directional arrows, a circle
and counter-circle for power on/off, letter shapes for app shortcuts, and
caret/vee for home and back.

## How a sample is produced

Understanding the rasterisation matters, because the images are not raw
drawings and cannot be reproduced without it.

1. Pointer positions are sampled during a drag, keeping a new point only once
   it is more than `clientWidth / 100` from the previous one.
2. The stroke's bounding box is scaled to fit a 32×32 canvas with 2px padding,
   preserving aspect ratio, and centred.
3. It is drawn on black with `lineWidth 2` and round caps and joins.
4. **The stroke colour ramps from `hsl(0, 0%, 10%)` at the start to
   `hsl(0, 0%, 90%)` at the end.** The greyscale gradient encodes stroke
   *direction*. This is what makes `circle` and `counterCircle` separable in a
   single static image, and it means the model is sensitive to stroke order,
   not only to shape.
5. Pixels are scaled to `[0, 1]` at training time.

## Classes

Label order is significant and matches the model's output index:

`up`, `down`, `left`, `right`, `circle`, `counterCircle`, `n`, `p`, `v`, `^`

## Splits

The published dataset is a single unsplit set. Training applies a stratified
80/20 train/validation split, and augmentation is applied **only to the
training side**, so validation is always un-augmented real samples.

## Limitations

- A single author, a single device, one screen geometry.
- No adversarial or accidental-input examples; the application handles those
  with a 0.6 confidence threshold rather than a reject class.
- Class counts are uneven; training oversamples to 10,000 per class with
  per-class augmentation.
```

Replace the class-count claim with the real distribution printed in Step 8 if it is worth stating precisely.

- [ ] **Step 8: Dry-run, then publish**

```bash
poetry run python publish_dataset.py --dry-run
```

Check the sample count matches Task 2's line count and the distribution looks sane. Then:

```bash
poetry run python publish_dataset.py
```

- [ ] **Step 9: Verify the published dataset loads**

```bash
poetry run python -c "
from datasets import load_dataset
dataset = load_dataset('ricmatsui/remote-gestures', split='train')
print(len(dataset), dataset.features['label'].names)
print(dataset[0]['image'].size, dataset[0]['image'].mode)
"
```

Expected: the full sample count, the ten names in `gestures.json` order, `(32, 32)`, `L`.

Now the `~/Desktop` backup from Task 2 Step 4 can be deleted.

- [ ] **Step 10: Commit**

```bash
cd /Users/ricardo/synced/Projects/home
git add roles/remote/model
git commit -m "Publish the gesture recordings as a HuggingFace dataset"
```

---

### Task 10: Train from the published dataset

Ports `$TV/model/train.py`. The training recipe, augmentation policy, model architecture, and split logic are all carried over unchanged — the only changes are the data source and a label-order assertion.

**Files:**
- Create: `roles/remote/model/train.py`
- Test: `roles/remote/model/tests/test_labels.py`

**Interfaces:**
- Consumes: the dataset from Task 9; `roles/remote/static/gestures.json`.
- Produces:
  - `assert_label_order(dataset_names, gestures) -> None` — raises `ValueError` on mismatch.
  - `model/out/model.keras` and `model/out/tfjs/` for Task 11.

- [ ] **Step 1: Write the failing test**

`roles/remote/model/tests/test_labels.py`:

```python
import pytest

from train import assert_label_order

GESTURES = [
    {'name': 'up', 'action': 'up'},
    {'name': 'down', 'action': 'down'},
    {'name': 'circle', 'action': 'powerOn'},
]


def test_matching_order_is_accepted():
    assert_label_order(['up', 'down', 'circle'], GESTURES)


def test_permuted_order_is_rejected():
    with pytest.raises(ValueError) as error:
        assert_label_order(['down', 'up', 'circle'], GESTURES)

    assert 'order' in str(error.value).lower()


def test_missing_label_is_rejected():
    with pytest.raises(ValueError):
        assert_label_order(['up', 'down'], GESTURES)


def test_extra_label_is_rejected():
    with pytest.raises(ValueError):
        assert_label_order(['up', 'down', 'circle', 'spiral'], GESTURES)
```

A permutation is the dangerous case: the model would train to good accuracy and the remote would send the wrong keys. Nothing else would catch it.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote/model
poetry run pytest tests/test_labels.py -v
```

Expected: FAIL, `ModuleNotFoundError: No module named 'train'`.

- [ ] **Step 3: Copy the original trainer as the starting point**

```bash
cp /Users/ricardo/synced/Projects/tv/model/train.py train.py
```

- [ ] **Step 4: Replace `load_data` and add the assertion**

In `train.py`, delete the existing `load_data()` (which reads `../tv/gestures.json` and `recordings.jsonl`) and its `base64`/`io`/`Image` imports, and put this in its place:

```python
import json
from pathlib import Path

import numpy as np
from datasets import load_dataset

ROOT = Path(__file__).parent
DATASET_ID = 'ricmatsui/remote-gestures'


def assert_label_order(dataset_names, gestures):
    expected = [gesture['name'] for gesture in gestures]

    if list(dataset_names) != expected:
        raise ValueError(
            'dataset label order does not match gestures.json.\n'
            f'  dataset:       {list(dataset_names)}\n'
            f'  gestures.json: {expected}\n'
            'Training would produce a model whose outputs are permuted.'
        )


def load_data():
    gestures = json.loads((ROOT.parent / 'static' / 'gestures.json').read_text())

    dataset = load_dataset(DATASET_ID, split='train')

    assert_label_order(dataset.features['label'].names, gestures)

    images = np.stack([
        np.array(image.convert('L'), dtype=np.float32) / 255.0
        for image in dataset['image']
    ])

    return dict(
        gestures=gestures,
        image_tensor=images[..., np.newaxis],
        gesture_index_tensor=np.array(dataset['label']),
    )
```

- [ ] **Step 5: Change the output path**

At the bottom of `train.py`, replace:

```python
tfjs.converters.save_keras_model(model, '../tv/model')
```

with:

```python
out = ROOT / 'out'
out.mkdir(exist_ok=True)
model.save(out / 'model.keras')
tfjs.converters.save_keras_model(model, str(out / 'tfjs'))
print(f'wrote {out}')
```

Leave `augment`, `build_model`, `split_data`, `train_model`, and the TensorBoard image-summary block exactly as they are.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
poetry run pytest tests/ -v
```

Expected: 8 passed (4 from Task 9, 4 here).

- [ ] **Step 7: Train**

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote/model
TF_USE_LEGACY_KERAS=1 poetry run python train.py
```

`TF_USE_LEGACY_KERAS=1` is required — the original `task train` set it, and `tf.keras.optimizers.legacy.Adam` needs it.

Expected: the class distributions print, training runs with early stopping, and `out/model.keras` plus `out/tfjs/model.json` and `out/tfjs/group1-shard1of1.bin` appear. Note the final validation accuracy — it goes in the model card.

- [ ] **Step 8: Commit**

```bash
cd /Users/ricardo/synced/Projects/home
git add roles/remote/model/train.py roles/remote/model/tests/test_labels.py
git commit -m "Train the gesture model from the published dataset"
```

---

### Task 11: Publish the model to HuggingFace

**Files:**
- Create: `roles/remote/model/publish_model.py`
- Create: `roles/remote/model/cards/model_card.md`

**Interfaces:**
- Consumes: `model/out/` from Task 10.
- Produces: the published model repo and, critically, **a commit SHA** that Task 12 pins.

- [ ] **Step 1: Write the model card**

`roles/remote/model/cards/model_card.md` — fill `{VAL_ACCURACY}` with the figure from Task 10 Step 7:

```markdown
---
license: mit
library_name: keras
pipeline_tag: image-classification
tags:
  - tensorflowjs
  - gesture-recognition
datasets:
  - ricmatsui/remote-gestures
metrics:
  - accuracy
---

# TV Gesture CNN

A small convolutional classifier that turns a single-stroke touch gesture into
one of ten television remote actions. It runs in the browser via TensorFlow.js
on the phone that drew the gesture; no inference happens server-side.

## Files

| file | purpose |
|---|---|
| `model.keras` | the trained Keras model |
| `tfjs/model.json`, `tfjs/group1-shard1of1.bin` | TensorFlow.js conversion, what the app loads |
| `gestures.json` | label order and the action each class maps to |

## Input

A 32×32 single-channel image scaled to `[0, 1]`, produced by the rasterisation
described in the [dataset card](https://huggingface.co/datasets/ricmatsui/remote-gestures).
The greyscale ramp along the stroke encodes direction, so **stroke order is
part of the input**, not just shape.

## Architecture

```
Input(32, 32, 1)
Conv2D(32, 3, relu, padding=same) -> MaxPool2D(2)
Conv2D(64, 3, relu, padding=same) -> MaxPool2D(2)
Flatten -> Dense(128, relu) -> Dropout(0.4) -> Dense(10, softmax)
```

## Training

- Optimiser: legacy Adam, `clipnorm=1.0`
- Learning rate: `CosineDecayRestarts(1e-4, first_decay_steps=50, t_mul=2.0, m_mul=0.9, alpha=1e-7)`
- Loss: sparse categorical cross-entropy
- Batch size 32, up to 500 epochs
- `EarlyStopping(monitor='val_loss', patience=30, restore_best_weights=True, min_delta=1e-4)`
- Stratified 80/20 split, applied **before** augmentation, so validation is un-augmented real data
- Each training class is oversampled to 10,000 with `RandomZoom((-0.1, 0.3))`,
  `RandomRotation(0.02)`, and `RandomTranslation(0.1, 0.1)`, plus per-class
  flips and rotations gated by the `allowMirrorHorizontal`,
  `allowMirrorVertical`, `allowRotation`, and `allowSlanted` flags in
  `gestures.json`

Validation accuracy: **{VAL_ACCURACY}**

## Intended use

Driving a Samsung television over its websocket remote API on a home network.

The application **rejects any prediction below 0.6 confidence** and treats it as
"unknown" — it vibrates three times and sends nothing. That threshold is part
of how the model is used and should be carried over by anyone reusing it; the
model has no reject class of its own.

## Limitations

- One author's handwriting, one device, one screen geometry.
- Sensitive to stroke direction by design.
- Ten fixed classes; adding one requires retraining and republishing both the
  dataset and the model.
```

- [ ] **Step 2: Write the publisher**

`roles/remote/model/publish_model.py`:

```python
import argparse
import shutil
from pathlib import Path

from huggingface_hub import HfApi

ROOT = Path(__file__).parent
REPO_ID = 'ricmatsui/remote-gesture'


def stage(out, cards, gestures):
    staging = out / 'upload'

    if staging.exists():
        shutil.rmtree(staging)

    staging.mkdir(parents=True)

    # Copy the whole tfjs directory rather than naming shards: the converter
    # emits group1-shard1of1.bin today, but a larger model shards further and
    # nothing downstream should need editing when it does.
    shutil.copytree(out / 'tfjs', staging / 'tfjs')

    shutil.copy(out / 'model.keras', staging / 'model.keras')
    shutil.copy(gestures, staging / 'gestures.json')
    shutil.copy(cards / 'model_card.md', staging / 'README.md')

    return staging


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, default=ROOT / 'out')
    parser.add_argument('--repo-id', default=REPO_ID)
    parser.add_argument('--message', default='Update the gesture model')
    arguments = parser.parse_args()

    staging = stage(arguments.out, ROOT / 'cards', ROOT.parent / 'static' / 'gestures.json')

    api = HfApi()
    api.create_repo(arguments.repo_id, exist_ok=True, private=False)

    commit = api.upload_folder(
        folder_path=staging,
        repo_id=arguments.repo_id,
        commit_message=arguments.message,
    )

    print()
    print('published:', f'https://huggingface.co/{arguments.repo_id}')
    print('revision: ', commit.oid)
    print()
    print('The next deploy picks this up automatically: remote_model_ref')
    print('defaults to main. Pin to the revision above only to roll back:')
    print(f'  task deploy --tags remote -e remote_model_ref={commit.oid}')


if __name__ == '__main__':
    main()
```

- [ ] **Step 3: Publish**

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote/model
poetry run python publish_model.py
```

Note the printed revision SHA. Nothing needs it pasted anywhere — `remote_model_ref` floats on `main` — but it is what you would pin to in order to roll back, and Step 4 uses it to check anonymous access.

- [ ] **Step 4: Verify the artefacts are fetchable anonymously**

The Docker build downloads without credentials, so check it works logged out:

```bash
REVISION=<the-sha>
curl -fsSL -o /tmp/model.json \
  "https://huggingface.co/ricmatsui/remote-gesture/resolve/$REVISION/tfjs/model.json"
curl -fsSL \
  "https://huggingface.co/api/models/ricmatsui/remote-gesture/revision/main" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['sha']); print([f['rfilename'] for f in d['siblings']])"
python3 -c "import json; print(json.load(open('/tmp/model.json'))['format'])"
```

Expected: `layers-model`; the `sha` matching the revision just published; and the file list containing `gestures.json`, `model.keras`, `tfjs/model.json`, and one or more `tfjs/group1-shard*.bin`. If anything 401s, the repo is still private — fix visibility before continuing.

That API call is exactly what Task 13's Ansible fetch does, so a 200 here is the real precondition for the deploy: it both resolves `main` to a SHA and enumerates the files, which is why no shard filename is hardcoded anywhere downstream.

- [ ] **Step 5: Commit**

```bash
cd /Users/ricardo/synced/Projects/home
git add roles/remote/model/publish_model.py roles/remote/model/cards/model_card.md
git commit -m "Publish the gesture model to HuggingFace"
```

---

### Task 12: The container image

**Files:**
- Create: `roles/remote/Dockerfile`
- Create: `roles/remote/.dockerignore`
- Create: `roles/remote/defaults/main.yml`

**Interfaces:**
- Consumes: the published model from Task 11; the app from Tasks 4-8.
- Produces: a runnable image, and `remote_model_repo` / `remote_model_ref` for Task 13.

The image does **not** fetch the model. Task 13's Ansible tasks download it onto the control machine, into `static/model/` in the build context, and the Dockerfile just copies that directory in. Two things fall out of that: there is no `curl` stage and so no second base image to pin, and there is no shard filename anywhere in the build — Ansible asks HuggingFace what files exist. See the spec's "Model artefacts" section.

- [ ] **Step 1: Pin the base image**

```bash
docker buildx imagetools inspect python:3.13-slim | head -5
```

Record the digest. It goes in as `python:3.13-slim@sha256:<digest>` — tag *and* digest, matching `roles/ticker` and `roles/planner`.

- [ ] **Step 2: Write the defaults**

`roles/remote/defaults/main.yml`:

```yaml
---

remote_model_repo: ricmatsui/remote-gesture

# Which revision of the model repo to ship. `main` means a deploy after
# `task remote:publishModel` picks up the new model with no commit here.
# Override with a commit SHA to pin or roll back:
#   task deploy --tags remote -e remote_model_ref=<sha>
remote_model_ref: main
```

The resolved SHA is not silently lost: Task 13 stamps it on the image as a `home.remote.model_revision` label, so which model a running container serves stays answerable even though the ref floats.

- [ ] **Step 3: Write the dockerignore**

`roles/remote/.dockerignore`:

```
.venv
model
tests
docs
__pycache__
.pytest_cache
```

`model/` is excluded deliberately — TensorFlow and the recordings have no business in the runtime image. Nothing under `model/` is needed at runtime now that `gestures.json` lives in `static/`, so no negation is required here.

Note that `static/model` is **not** ignored, unlike in `.gitignore`. It is gitignored because it is a build artefact, but it must reach the build context because it is what Ansible just downloaded.

- [ ] **Step 4: Write the Dockerfile**

`roles/remote/Dockerfile`:

```dockerfile
FROM python:3.13-slim@sha256:<digest>

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY templates ./templates

# static/ carries two label files with the same name and different jobs:
#   static/gestures.json       the roster, committed to git
#   static/model/gestures.json the label vector, plus model.json and the
#                              weight shards, downloaded from HuggingFace by
#                              Ansible before this build
# Building by hand without that fetch produces an image that 404s on /model/.
COPY static ./static

USER 1000

EXPOSE 5002

# Exactly one worker. The control worker thread starts at import, so a second
# worker means a second websocket fighting over the television.
CMD ["gunicorn", "--workers", "1", "--threads", "4", \
     "--bind", "0.0.0.0:5002", "app:create_app()"]
```

- [ ] **Step 5: Export the requirements file**

The image installs from a plain requirements file rather than running poetry:

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote
poetry export --without dev --format requirements.txt --output requirements.txt
```

If `poetry export` is unavailable, `poetry self add poetry-plugin-export` first. Commit `requirements.txt`; it is generated but must be reproducible in the build context.

Add a note to `roles/remote/pyproject.toml` above `[tool.poetry.dependencies]`:

```toml
# Re-run `poetry export --without dev -f requirements.txt -o requirements.txt`
# after changing anything here; the Dockerfile installs from that file.
```

- [ ] **Step 6: Fetch the model by hand, then build locally**

The Ansible tasks that normally do this land in Task 13; do it manually here so the image can be smoke-tested first. This is also a dry run of the exact API calls Task 13 makes.

```bash
cd /Users/ricardo/synced/Projects/home/roles/remote
mkdir -p static/model

SHA=$(curl -fsSL "https://huggingface.co/api/models/ricmatsui/remote-gesture/revision/main" \
        | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])")
echo "resolved: $SHA"

curl -fsSL "https://huggingface.co/api/models/ricmatsui/remote-gesture/revision/$SHA" \
  | python3 -c "
import json, sys
for sibling in json.load(sys.stdin)['siblings']:
    name = sibling['rfilename']
    if name.startswith('tfjs/') or name == 'gestures.json':
        print(name)
" \
  | while read -r name; do
      curl -fsSL -o "static/model/$(basename "$name")" \
        "https://huggingface.co/ricmatsui/remote-gesture/resolve/$SHA/$name"
    done

docker build -t remote-test .
docker run --rm remote-test ls -la /app/static/model
```

Expected: `model.json`, `gestures.json`, and one or more `group1-shard*.bin`, all non-empty. Note that the shard names came from the API, not from this script — that is the point.

Confirm both label files are present and distinct paths:

```bash
docker run --rm remote-test sh -c 'ls /app/static/gestures.json /app/static/model/gestures.json'
```

Expected: both listed. The first is the committed roster, the second the fetched label vector; an image missing either is broken in a way that only shows up in the browser.

`static/model/` is gitignored, so leaving it populated is harmless and saves refetching during Task 13.

- [ ] **Step 7: Smoke-test the container without a television**

```bash
docker run --rm -p 5002:5002 \
  -e REMOTE_TV_IP=192.0.2.1 -e REMOTE_TV_MAC=00:00:00:00:00:00 -e REMOTE_TV_TOKEN=x \
  -e REMOTE_LAN_CIDR=172.17.0.0/16 \
  -e RECORDINGS_PATH=/tmp/recordings.jsonl \
  remote-test
```

In another shell:

```bash
curl -s localhost:5002/ | grep -c debug-canvas
curl -s -o /dev/null -w '%{http_code}\n' localhost:5002/model/model.json
curl -s localhost:5002/gestures.json | head -c 60
```

Expected: `1`, `200`, and the start of the gesture array. The control worker will log connection errors to `192.0.2.1` on a loop — that is correct behaviour and proves the worker started. `REMOTE_LAN_CIDR` is set to the docker bridge here only so `select_lan_interface` finds something.

- [ ] **Step 8: Commit**

```bash
cd /Users/ricardo/synced/Projects/home
git add roles/remote/Dockerfile roles/remote/.dockerignore roles/remote/defaults roles/remote/requirements.txt roles/remote/pyproject.toml
git commit -m "Build the remote image from the fetched gesture model"
```

---

### Task 13: The Ansible role

**Files:**
- Create: `roles/remote/tasks/main.yml`

**Interfaces:**
- Consumes: `config.remote.*` (added in Step 1), `remote_model_repo` and `remote_model_ref` from Task 12.
- Produces: the deployed `remote` stack.

- [ ] **Step 1: Add the secrets to the env submodule**

Copy the values out of the old project and into this one:

```bash
cd /Users/ricardo/synced/Projects/tv
sops -d config.yml | grep -A6 '^    tv:'
```

Then:

```bash
cd /Users/ricardo/synced/Projects/home
sops env/inventory/group_vars/all.sops.yml
```

Add, under `config:`:

```yaml
    remote:
        ip: <television LAN address, from config.tv.ip>
        mac: <from config.tv.mac>
        token: <from config.tv.token>
        lan_cidr: <the subnet from config.docker.ipvlan_ipam_config, per Task 1>
```

`config.tv.tv_host` is deliberately not carried over; the container binds `0.0.0.0`.

- [ ] **Step 2: Write the role tasks**

`roles/remote/tasks/main.yml`:

```yaml
---

- name: set dns record
  community.general.cloudflare_dns:
    zone: "{{ config.cloudflare.zone }}"
    record: "remote.{{ config.domain }}"
    type: A
    value: "{{ config.ip }}"
    api_token: "{{ config.cloudflare.api_key }}"
  delegate_to: localhost

- name: create directories
  ansible.builtin.file:
    path: /mnt/gluster/remote/data
    owner: pi
    group: pi
    state: directory

- name: resolve model revision
  ansible.builtin.uri:
    url: "https://huggingface.co/api/models/{{ remote_model_repo }}/revision/{{ remote_model_ref }}"
  delegate_to: localhost
  register: remote_model_info

- name: create model directory
  ansible.builtin.file:
    path: "{{ role_path }}/static/model"
    state: directory
  delegate_to: localhost

- name: download model files
  ansible.builtin.get_url:
    url: "https://huggingface.co/{{ remote_model_repo }}/resolve/{{ remote_model_info.json.sha }}/{{ item }}"
    dest: "{{ role_path }}/static/model/{{ item | basename }}"
  loop: "{{ remote_model_info.json.siblings | map(attribute='rfilename')
            | select('match', '^(tfjs/|gestures\\.json$)') | list }}"
  delegate_to: localhost

- name: build
  community.docker.docker_image_build:
    name: "gitea.{{ config.domain }}/{{ config.gitea.username }}/remote"
    tag: latest
    path: "{{ role_path }}"
    rebuild: always
    labels:
      home.remote.model_revision: "{{ remote_model_info.json.sha }}"
    platform:
      - linux/amd64
      - linux/arm64/v8
    outputs:
      - type: image
        push: true
  delegate_to: localhost
  register: build_result

- name: deploy stack
  community.general.docker_stack:
    name: remote
    prune: yes
    resolve_image: always
    compose:
      - version: '3.8'
        services:
          remote:
            image: "{{ build_result.image.RepoDigests[0] }}"
            networks:
              traefik_traefik:
              ipvlan:
            environment:
              REMOTE_TV_IP: "{{ config.remote.ip }}"
              REMOTE_TV_MAC: "{{ config.remote.mac }}"
              REMOTE_TV_TOKEN: "{{ config.remote.token }}"
              REMOTE_LAN_CIDR: "{{ config.remote.lan_cidr }}"
              RECORDINGS_PATH: /data/recordings.jsonl
              TZ: America/Los_Angeles
            volumes:
              - /mnt/gluster/remote/data:/data
            deploy:
              # replicas MUST stay 1: the container holds a single websocket
              # to the television, and two would fight over it.
              mode: replicated
              replicas: 1
              labels:
                - "home.scheduler.replicas=1"
                - "home.scheduler.priority=30"
                - "home.scheduler.restart=true"
                - "traefik.enable=true"
                - "traefik.http.routers.remote.rule=Host(`remote.{{ config.domain }}`)"
                - "traefik.http.routers.remote.middlewares=traefik-internal"
                - "traefik.http.routers.remote.entrypoints=websecure"
                - "traefik.http.routers.remote.tls.certresolver=letsencrypt"
                - "traefik.http.services.remote.loadbalancer.server.port=5002"
              resources:
                limits:
                  cpus: '0.25'
                  memory: 128M
              restart_policy:
                delay: 30s
              update_config:
                order: stop-first
        networks:
          traefik_traefik:
            external: true
          ipvlan:
            external: true
  vars:
    ansible_python_interpreter: /opt/docker_venv/bin/python

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

Four things to note, all deliberate and all explained in the spec:

- **No `placement.constraints` block and no `sherpa.*` labels.** Every node's ipvlan parent is on the television's segment, and nothing needs to reach the container inbound over ipvlan.
- **The model fetch runs `delegate_to: localhost`**, into the build context, immediately before the build. `get_url` is idempotent on content, so a re-run with an unchanged revision is a no-op and the build layer caches.
- **The file list comes from the API's `siblings`**, so no shard filename appears anywhere. A retrained model that shards into three files needs no change here.
- **The resolved SHA is stamped as an image label.** `remote_model_ref` floats on `main`, so this label is the only record of which model a running container actually serves. Read it back with:

  ```bash
  ssh pi 'docker image inspect $(docker service inspect remote_remote \
    --format "{{.Spec.TaskTemplate.ContainerSpec.Image}}") \
    --format "{{index .Config.Labels \"home.remote.model_revision\"}}"'
  ```

And the backup script, last in the file: `recordings.jsonl` is the only irreplaceable state this service holds, since every gesture recorded since the last `remote:publishDataset` exists nowhere else. It follows `roles/paper` — a dated copy of a live file — with no `stop_docker_service` dance, because the file is append-only and a torn read at worst loses a final partial line that `publish_dataset.py` rejects anyway.

It sits **after** `deploy stack`, matching every other role that configures one — `donetick`, `paper`, `actual`, `vaultwarden`, `gitea`, and `vikunja` all put `configure backup` last.

- [ ] **Step 3: Check the syntax**

```bash
cd /Users/ricardo/synced/Projects/home
poetry run ansible-playbook playbook.yml --syntax-check
```

This will fail until Task 14 adds the role to the playbook. If so, defer this step to Task 14 Step 5.

- [ ] **Step 4: Commit**

```bash
git add roles/remote/tasks/main.yml
git commit -m "Deploy the remote stack on the Traefik and ipvlan networks"
```

- [ ] **Step 5: Confirm the backup script is picked up**

The `rclone_backup` role runs everything in `/mnt/gluster/rclone/scripts`. After the first deploy:

```bash
ssh pi 'ls -la /mnt/gluster/rclone/scripts/remote.sh'
ssh pi 'ARCHIVE_PATH=/tmp/archive-check BACKUP_DATE=$(date +%F) bash -n /mnt/gluster/rclone/scripts/remote.sh'
```

Expected: the script exists, is executable, and `bash -n` reports no syntax error. Leave the real run to the scheduled timer.

---

### Task 14: Wire it into the repository

**Files:**
- Modify: `playbook.yml`
- Modify: `tasksfile.js`
- Modify: `roles/homepage/files/public/index.html`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `task deploy --tags remote` and the `task remote:*` workflow.

- [ ] **Step 1: Add the role to the playbook**

In `playbook.yml`, in the `deploy` play, after the `impression` role:

```yaml
    - role: remote
      tags: remote
```

- [ ] **Step 2: Add the workflow tasks**

Replace `tasksfile.js` with:

```javascript
const path = require('path')
const { sh, cli, rawArgs } = require('tasksfile')

const modelPath = path.join(__dirname, 'roles', 'remote', 'model')

const setup = () => {
    sh('yarn', { nopipe: true });
    sh('poetry install', { nopipe: true });
    sh('poetry run ansible-galaxy collection install -r requirements.yml', { nopipe: true });
}

const deploy = () => {
    sh(`poetry run ansible-playbook playbook.yml ${rawArgs().join(' ')}`, { nopipe: true });
}

const remote = {
    publishDataset: () => {
        sh('scp pi:/mnt/gluster/remote/data/recordings.jsonl recordings.jsonl', {
            cwd: modelPath,
            nopipe: true,
        });

        sh(`poetry run python publish_dataset.py ${rawArgs().join(' ')}`, {
            cwd: modelPath,
            nopipe: true,
        });
    },

    train: () => {
        sh('poetry run python train.py', {
            cwd: modelPath,
            nopipe: true,
            env: { TF_USE_LEGACY_KERAS: '1' },
        });
    },

    publishModel: () => {
        sh(`poetry run python publish_model.py ${rawArgs().join(' ')}`, {
            cwd: modelPath,
            nopipe: true,
        });
    },

    monitorTraining: () => {
        sh('poetry run tensorboard --logdir logs', {
            cwd: modelPath,
            nopipe: true,
        });
    },
}

cli({ setup, deploy, remote });
```

Two decisions in there:

**Download is folded into `publishDataset` rather than being its own task.** There is no realistic reason to pull the recordings without publishing them — the local jsonl is a staging file, not something to keep — and two separate tasks invite publishing a stale copy that was fetched days ago. The intermediate still lands at `model/recordings.jsonl` (gitignored) so it can be inspected after a run.

**The scp is plain, with no kitty workaround.** Elsewhere in this repository non-interactive ssh gets `TERM=xterm` and `/usr/bin/ssh`; this deliberately tries without, to find out whether it is still needed. If the scp hangs or errors on terminfo, restore it:

```javascript
sh('scp -S /usr/bin/ssh pi:/mnt/gluster/remote/data/recordings.jsonl recordings.jsonl', {
    cwd: modelPath,
    nopipe: true,
    env: { TERM: 'xterm' },
});
```

- [ ] **Step 3: Verify the tasks are registered**

```bash
cd /Users/ricardo/synced/Projects/home
task --help
```

Expected: `remote:publishDataset`, `remote:train`, `remote:publishModel`, `remote:monitorTraining` all listed. There is no `remote:download` — see Step 2.

- [ ] **Step 4: Add the homepage entry**

In `roles/homepage/files/public/index.html`, after the Ticker block (around line 80):

```html
        <h2>
            <a rel='noopener' href='https://remote.<!--#echo var="domain"-->'>
                Remote
            </a>
        </h2>
```

- [ ] **Step 5: Add the README entry**

In `README.md`, in the alphabetical service list, between "PaperMC" and "Resilio Sync":

```markdown
- Remote (TV)
```

Also add a git-lfs prerequisite near the setup instructions — Task 3 Step 2b made this repository depend on it, and a clone without `git-lfs` installed silently gets pointer files instead of the `.xcf` sources:

```markdown
Requires [git-lfs](https://git-lfs.com) for the `.xcf` design sources.
```

- [ ] **Step 6: Syntax-check the playbook**

```bash
poetry run ansible-playbook playbook.yml --syntax-check
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add playbook.yml tasksfile.js roles/homepage/files/public/index.html README.md
git commit -m "Wire the remote role into the playbook and workflow tasks"
```

---

### Task 15: Deploy and verify end to end

**Files:** none.

**Interfaces:**
- Consumes: everything.
- Produces: a working service, and the go/no-go for Task 16.

- [ ] **Step 1: Deploy**

```bash
cd /Users/ricardo/synced/Projects/home
task deploy --tags remote
```

If the working directory is `roles/remote` rather than the repo root, use the form from Global Constraints instead — the `cd` is not optional:

```bash
direnv exec /Users/ricardo/synced/Projects/home \
  sh -c 'cd /Users/ricardo/synced/Projects/home && task deploy --tags remote'
```

- [ ] **Step 2: Confirm the service is up and on both networks**

```bash
ssh pi 'docker service ps remote_remote --no-trunc'
ssh pi 'docker service inspect remote_remote --format "{{json .Spec.TaskTemplate.Networks}}"'
```

Expected: one running replica; two networks attached.

- [ ] **Step 3: Confirm exactly one replica and one worker**

```bash
ssh pi 'docker service ls --filter name=remote_remote'
ssh pi 'docker service logs remote_remote 2>&1 | grep -c "Booting worker"'
```

Expected: `1/1`, and exactly one booted worker. **More than one of either is a defect — stop and fix before continuing.**

- [ ] **Step 4: Confirm the WoL interface was resolved at startup**

```bash
ssh pi 'docker service logs remote_remote 2>&1 | grep "wol will use"'
```

Expected: a source address inside the LAN CIDR and the matching broadcast address. If this line is missing or the source is a `172.x` overlay address, `REMOTE_LAN_CIDR` is wrong.

- [ ] **Step 5: Load the page over HTTPS**

Open `https://remote.<domain>` on the phone. Check:

- The page loads and the two vertical rules and bottom bar render.
- No console errors, and no request to `unpkg.com` — htmx was dropped. A request to `cdn.jsdelivr.net` for `@tensorflow/tfjs@4.20.0` **is expected**: tfjs is deliberately not vendored. Confirm the version in that URL matches the converter version on the model card.
- `/model/model.json` and its shard load (Network tab).
- The screen does not dim after a minute — that proves `navigator.wakeLock` got a secure context.
- "Add to Home Screen" is offered — that proves the manifest is being served.

- [ ] **Step 6: Verify gesture recognition and control**

With the television **on**:

- Draw each of the ten gestures and confirm the debug canvas shows the stroke and `gesture-debug` reports the right name with confidence above 0.6.
- Confirm arrows move the highlight, a short tap is Enter, a tap in the left 20% is volume down and the right 20% is volume up.
- Confirm `n` opens Netflix and `p` opens Peacock.
- Confirm `v` is Back and `^` is Home.
- Confirm a deliberate scribble is rejected with a triple vibration and no key sent.

- [ ] **Step 7: Verify Wake-on-LAN — the critical one**

Turn the television **off**, wait for it to drop off the network, then draw `circle`.

Expected: the first attempt fails to connect, the container sends the magic packet, the television wakes. Watch it happen:

```bash
ssh pi 'docker service logs -f remote_remote'
```

Expected log sequence: `<- error …`, then `-> wol`, then on the retry `! skipping powerOn` (the television is already awake — sending `KEY_POWER` now would turn it back off).

- [ ] **Step 8: Verify recording persistence**

Tick Record, draw a gesture, then:

```bash
ssh pi 'tail -c 200 /mnt/gluster/remote/data/recordings.jsonl; wc -l /mnt/gluster/remote/data/recordings.jsonl'
```

Expected: line count is the Task 2 count plus one. Press Delete and confirm it goes back down.

- [ ] **Step 9: Verify it survives rescheduling onto another node**

This checks the "no placement constraint" assumption from the spec:

```bash
ssh pi 'docker service update --force remote_remote'
```

Wait for it to settle, note which node it landed on, then repeat Steps 4 and 7. If WoL fails on the new node, that node's `docker_ipvlan_parent` is on a different segment and the role needs a placement constraint after all.

- [ ] **Step 10: Record the outcome**

```bash
cd /Users/ricardo/synced/Projects/home
$EDITOR docs/superpowers/specs/2026-09-06-remote-role-design.md
git add docs/superpowers/specs/2026-09-06-remote-role-design.md
git commit -m "Record the verified remote role behaviour"
```

**Do not start Task 16 until every step above passes.** Until the old service is removed, rollback is just re-pointing DNS.

---

### Task 16: Decommission the old deployment

**Files:**
- Modify: `$TV` repository (archived, not edited)

**Interfaces:**
- Consumes: a verified Task 15.
- Produces: nothing running from the old project.

- [ ] **Step 1: Final reconciliation of the recordings**

The old app has kept appending to `/opt/tv/recordings.jsonl` since Task 2. Capture anything new:

```bash
cd /Users/ricardo/synced/Projects/home
scp autopi:/opt/tv/recordings.jsonl /tmp/recordings-final.jsonl
wc -l /tmp/recordings-final.jsonl roles/remote/model/recordings.jsonl
diff <(sort /tmp/recordings-final.jsonl) <(sort roles/remote/model/recordings.jsonl) | head
```

If there are new lines, append them to `/mnt/gluster/remote/data/recordings.jsonl`, then re-run `task remote:publishDataset` (which re-fetches before publishing).

- [ ] **Step 2: Remove the proxy stack**

```bash
ssh pi 'docker stack rm tv-proxy'
ssh pi 'docker stack ls'
```

Expected: `tv-proxy` gone, `remote` present.

- [ ] **Step 3: Remove the systemd service from autopi**

```bash
ssh autopi 'sudo systemctl disable --now tv'
ssh autopi 'sudo rm /etc/systemd/system/tv.service'
ssh autopi 'sudo systemctl daemon-reload'
ssh autopi 'systemctl status tv' || true
```

Expected: the unit no longer exists.

- [ ] **Step 4: Remove the old install**

Only after Step 1 confirmed the data is safe:

```bash
ssh autopi 'sudo rm -rf /opt/tv /opt/tv_venv'
```

- [ ] **Step 5: Delete the old DNS record**

Remove the `tv.<domain>` A record in the Cloudflare dashboard. It is no longer managed by any playbook, so nothing will recreate it — and nothing will remove it either.

- [ ] **Step 6: Confirm the old hostname is dead and the new one lives**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://remote.<domain>/
dig +short tv.<domain>
```

Expected: `200` (or a Traefik auth response), and no answer for the old name.

- [ ] **Step 7: Archive the old repository**

In Gitea, mark the `tv` repository archived.

Before you do, confirm the `.xcf` sources really did make it across under LFS, since archiving is the point of no easy return:

```bash
cd /Users/ricardo/synced/Projects/home
git lfs ls-files | grep xcf
file roles/remote/assets/logo.xcf roles/remote/assets/help.xcf
```

Expected: both listed by LFS, and both reported as `GIMP XCF image data`. If either is a pointer file on disk, run `git lfs pull` and re-check before archiving.

- [ ] **Step 8: Mark the spec complete**

```bash
cd /Users/ricardo/synced/Projects/home
sed -i '' 's/^\*\*Status:\*\* .*/**Status:** Implemented/' \
  docs/superpowers/specs/2026-09-06-remote-role-design.md
git add docs/superpowers/specs/2026-09-06-remote-role-design.md
git commit -m "Mark the remote role design implemented"
```

---

## Retraining afterwards

Recorded once and want a better model? The loop is:

1. Tick Record in the app and draw the prompted gestures.
2. `task remote:publishDataset` — fetches the recordings off `pi`, then publishes
3. `task remote:train`
4. `task remote:publishModel`
5. `task deploy --tags remote`

There is no revision-bump commit in the middle: `remote_model_ref` defaults to `main`, so the deploy resolves and ships whatever was just published. Traceability comes from the `home.remote.model_revision` label stamped on the image rather than from git history — read it back with the `docker image inspect` command in Task 13 Step 2.

To ship a specific older model instead, pin the ref for that one deploy:

```bash
task deploy --tags remote -e remote_model_ref=<sha>
```

## Adding a gesture

Same loop with a deploy in front of it, because record mode can only prompt for gestures in the roster it was served:

1. Append the gesture to `roles/remote/static/gestures.json`. **Append** — reordering existing entries permutes the dataset's `ClassLabel` indices against the deployed model.
2. `task deploy --tags remote`. Record mode now prompts for it; inference still runs the old model, which knows nothing about it.
3. Record samples for it in the app.
4. `task remote:publishDataset` → `task remote:train` → `task remote:publishModel`.
5. `task deploy --tags remote`. The new label vector arrives with the new weights.

Between steps 2 and 5 the gesture is recordable but not predictable — drawn in normal use it either misclassifies into an existing class or falls below the `0.6` threshold and reads as "unknown". Same as any unrecognised input, so nothing breaks, but record mode gives no hint which prompts the deployed model cannot yet handle.

Step 1 before step 2 matters in the other direction too: `publish_dataset.py` rejects recordings whose gesture name is not in `gestures.json`, so samples recorded for a gesture that was never added would be thrown out at publish time.
