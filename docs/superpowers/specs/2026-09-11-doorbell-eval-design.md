# Doorbell Eval Harness — Design

**Date:** 2026-09-11
**Branch:** `add-doorbell-role`
**Status:** Designed

## Goal

A local CLI in `roles/doorbell` that runs a folder of images through the service's
real detection path and scores the result against hand-written labels, so that two
questions can be answered with evidence instead of impressions:

1. **Does it work?** Which frames does the model get wrong, and what do those frames
   have in common.
2. **Is this model better than that one?** Run A against run B, with an honest answer
   about whether the difference is real.

The harness is a development tool. It is not deployed, not scheduled, and nothing in
the running service depends on it.

## Why the labels matter more than the harness

The harness is a few hundred lines. The corpus is the asset, and the thing that makes
a corpus useful is not its size but whether it is adversarial against this specific
camera: IR night frames, the shadow of the railing at dusk, leaves moving, a delivery
box, a dog, a cat half out of frame or behind the railing. A hundred frames chosen
for the ways this system actually fails is worth more than a thousand sampled at
random from a sunny afternoon.

Everything below is therefore built around making re-labeling cheap and repeatable,
because the corpus will be revised many times and a golden set that is painful to
extend stops being extended.

## Scope

In scope:

- `roles/doorbell/src/eval/`: `corpus.ts`, `metrics.ts`, `report.ts`, `cli.ts` plus
  unit tests for the three pure modules.
- Three CLI modes: `bootstrap`, `run`, `compare`.
- A local corpus directory at `roles/doorbell/eval/`, recursively walked, fully
  ignored by git and by the Docker build context.
- Binary verdict scoring only: confusion matrix, precision, recall, F1, and F-beta.
- Per-run JSON artifacts and an HTML contact sheet of annotated frames.
- Run-to-run comparison with a significance-aware verdict line.
- A `yarn eval` script and a one-line change to the existing `test` script.
- README section documenting corpus seeding and the workflow.

Out of scope (YAGNI):

- **Episode replay.** Replaying ordered frames through `CatPresence` / `ActivityWindow`
  to count sensor flips and sweep `missLimit` offline. This is the natural next layer
  and the per-image results are the seam it would attach to, but it is not v1.
- **Box-level metrics.** No IoU, no mAP. The service reduces every response to one
  boolean through `hasCat()`; scoring geometry would measure something nothing consumes.
  The run artifact keeps raw detections, so this can be added without a re-run.
- **Determinism repeats.** No `--repeat`, no percentile latency analysis. Per-image
  `ms` is recorded because it is free, but nothing analyses it.
- **CI gating.** The harness needs LM Studio reachable, so it cannot join the unit
  test suite. A threshold-gated regression mode can sit on top of the run artifact later.
- **A labeling UI.** Labels are corrected by hand in `labels.json` against a generated
  contact sheet.

## Approaches considered

**A Python harness on FiftyOne.** The actual industry tool for comparing detectors over
an image dataset, with a far better browsing UI than anything hand-rolled here.
Rejected: it cannot call the TypeScript path, so it would reimplement the LM Studio
call, the zod schema and `hasCat` — discarding precisely the end-to-end confidence this
exists to provide. It is the right answer at ten thousand images and box-level metrics;
it is the wrong answer at a hundred images and a boolean.

**A threshold-gated `node --test` suite.** Fits the existing test idiom and would gate
regressions in one command. Rejected as the primary shape: tests are pass/fail, not a
comparison table, and this suite needs LM Studio up, so it cannot live beside the pure
unit tests. Worth layering on later once a baseline run exists.

**A standalone CLI reusing the production modules.** Chosen. It exercises the real code
path including the schema and the label matching in `hasCat`, adds no dependency, and
gets the model × prompt matrix from two flags.

## Corpus

```
roles/doorbell/eval/            # gitignored in full
  images/                       # walked recursively, any layout
  labels.json
  sheet.html                    # generated
  runs/
    2026-09-11T18-04-00Z-gemma-3-12b.json
    2026-09-11T18-04-00Z-gemma-3-12b/
      index.html
      *.jpg                     # annotated
```

The whole directory is ignored, not just the images, so that `eval/` can be replaced
by a symlink or a bind mount to storage that lives elsewhere. Two consequences the
implementation must respect:

- **The walk follows symlinks.** Directory entries are resolved with `stat`, not
  `lstat`, so a symlinked subdirectory of frames is traversed rather than skipped.
  Resolved real paths are tracked to break cycles, which a symlink pointing at an
  ancestor would otherwise create.
- **`eval` is added to `.dockerignore`.** `tasks/main.yml` builds with
  `path: "{{ role_path }}"`, so the corpus would otherwise be uploaded as build context
  on every deploy — and if `eval/` is a mount, that is arbitrarily large.

`eval/` also goes into the role's existing `.gitignore` alongside `dist/` and
`node_modules/`.

### Labels

`labels.json` maps the POSIX-relative path from `images/` to a verdict:

```json
{
  "2026-09-11/160141.raw.jpg": { "cat": false },
  "night/porch-ir-03.jpg":     { "cat": true, "note": "cat behind the railing, IR" },
  "hard-negatives/leaves.jpg": { "cat": false, "note": "wind, dusk" }
}
```

The relative path is the key, which is what removes any filename convention: frame
names collide across days (`160141.raw.jpg` exists in every date directory) but
`2026-09-11/160141.raw.jpg` does not. Folders can be copied in as they are.

`note` is optional and exists because a false positive reviewed six weeks later is a
mystery without one.

### Seeding

Documented as a shell command rather than an import mode:

    mkdir -p roles/doorbell/eval/images/2026-09-11
    cp /mnt/gluster/doorbell/frames/2026-09-11/*.raw.jpg \
       roles/doorbell/eval/images/2026-09-11/

Only the raw frames are copied. The `-cat.jpg` / `-nocat.jpg` siblings on gluster are a
previous run's own output, and scoring a model against images it already drew boxes on
would be circular. Any other folder of images can be dropped in the same way.

## CLI

    yarn eval bootstrap [--dir <corpus>]
    yarn eval run       [--dir <corpus>] --model <name> [--url <ws://…>] [--prompt-file <f>] [--limit <n>]
    yarn eval compare   <runA.json> <runB.json> [--beta <n>]

Arguments are parsed with `node:util`'s `parseArgs`. No new dependencies: the harness
uses `jimp`, `zod` and `@lmstudio/sdk`, all already present.

`--dir` defaults to the `eval/` directory resolved from the package root via
`import.meta.url`, not from the process working directory, so the command behaves the
same from the repo root as from the role.

The harness does **not** call `loadConfig()`. That function requires
`GOOGLE_CREDENTIALS_BASE64`, MQTT, go2rtc and the rest; this needs a model name and a
URL, and defaults the URL to the same `ws://<redacted>:1234` the
service uses.

### `bootstrap`

Walks `images/` recursively, taking `.jpg` / `.jpeg` / `.png` and skipping dotfiles and
AppleDouble `._*` entries — `frames/` already contains `._.DS_Store`, and without that
filter it would be handed to the model as an image.

It then **merges** into `labels.json`: existing labels are preserved untouched, unseen
files are added as `{"cat": false}`, and labels whose image no longer exists are kept
but counted and reported as `orphaned: 3`. Merging rather than regenerating is the
entire point of the mode — new hard negatives get added repeatedly, and a bootstrap
that discarded prior work would make the corpus disposable.

It regenerates `sheet.html`: every image as a thumbnail, grouped by directory, captioned
with its relative path and current label, so labels can be corrected in an editor
against something visual.

Output summarises `found`, `added`, `orphaned`, and the current positive/negative split.

### `run`

For each labelled image, in stable path order: call `vision.detect(path)` — the real
client from `vision.ts` — then `hasCat()` on the result, and compare to the label.

Images present under `images/` but absent from `labels.json` are **skipped with a
warning** naming the count, rather than guessed at or scored as negatives; the fix is
to re-run `bootstrap`. `--limit` caps the number of images scored, for a quick smoke
run against a new model without paying for the whole corpus.

An inference or schema failure records the error and an `outcome: "error"`, and is
**excluded from the confusion matrix** rather than counted as a negative. A failed call
is not evidence of no cat, which is the same reasoning `index.ts` already applies to a
failed frame grab.

`--prompt-file` overrides the module-level `PROMPT`. This requires `vision.ts` to accept
an optional prompt in `createVisionClient` options, defaulting to the existing constant
— a small, backward-compatible change to production code, and the only one this design
makes. Prompt is frequently a bigger lever on quality than model choice, and leaving it
hard-coded would make half the interesting experiments impossible.

### `compare`

Reads two run files, prints both summaries side by side, the flip list, and a verdict.
It **refuses** to compare runs whose scored image sets differ, and **warns** when
`labelsSha` differs between them: comparing across shifted ground truth silently is
worse than not comparing at all.

## Run artifact

`runs/<iso>-<model-slug>.json`:

```json
{
  "startedAt": "2026-09-11T18:04:00.000Z",
  "model": "gemma-3-12b-it-qat",
  "baseUrl": "ws://<redacted>:1234",
  "prompt": "Provide the bounding box coordinates for detect all cats…",
  "promptSha": "3f9a1c…",
  "labelsSha": "b72e04…",
  "corpus": { "dir": "…/eval", "images": 103, "positives": 24 },
  "summary": {
    "tp": 22, "fp": 3, "fn": 2, "tn": 76, "errors": 0,
    "precision": 0.880, "recall": 0.917, "f1": 0.898, "fbeta": 0.887, "beta": 0.5,
    "totalMs": 241300,
    "byDirectory": {
      "2026-09-11": { "tp": 18, "fp": 1, "fn": 0, "tn": 60, "recall": 1.0, "precision": 0.947 },
      "night":      { "tp": 4,  "fp": 2, "fn": 2, "tn": 16, "recall": 0.667, "precision": 0.667 }
    }
  },
  "results": [
    {
      "image": "2026-09-11/160141.raw.jpg",
      "expected": true, "verdict": true, "outcome": "tp",
      "detections": [{ "label": "cat", "bbox_2d": [412, 388, 596, 620] }],
      "ms": 2100, "error": null
    }
  ]
}
```

`promptSha` and `labelsSha` are what make a run file attributable months later; without
them an old artifact records a number and not the conditions that produced it.

`byDirectory` exists because the corpus is organised by folder, so folders should mean
something. One averaged recall hides exactly the split worth seeing — `night/` at 0.67
against `2026-09-11/` at 1.0 is the finding, and the aggregate buries it.

## Scoring

### F-beta, not F1

The ranking metric is **F-beta with `--beta` defaulting to 0.5**, weighting precision
twice as heavily as recall. Precision, recall and F1 are all still reported; only the
ranking uses F-beta.

This follows from the service's own constants. With `window_ms` 120000 and `poll_ms`
30000 there are roughly four frames per window, and `missLimit` is 3. So:

- A **false positive** latches presence ON and needs three consecutive clean frames to
  clear it — about ninety seconds of wrong sensor state.
- A **false negative** usually costs nothing. If presence was already ON the latch
  absorbs it; if it was OFF, there is another frame thirty seconds later.

The errors are not symmetric, so a metric that weights them equally ranks models by the
wrong thing. The compare header prints this reasoning so the choice is visible rather
than buried in a constant.

### Significance

At n ≈ 100 a difference of two images is noise, and a tool that crowns a winner on a
0.02 delta launders noise into a decision. `compare` therefore runs **McNemar's test**
over the discordant pairs — the images where the two runs disagree, which is exactly the
flip list it already computes. At this n an exact two-sided binomial on the flip counts
is both correct and about ten lines with no new dependency.

The verdict line reads as one of:

    verdict: B better — F0.5 +0.112 (0.788 → 0.900), 14 fixed / 2 broke, McNemar p=0.004
    verdict: no clear winner — F0.5 +0.031, 3 fixed / 1 broke, McNemar p=0.625 (n too small to call)

The second form is the one that earns the feature. What no statistic here can speak to
is generalization beyond this porch at the hours that happen to be sampled; that is a
corpus problem, not a math problem, and the README says so.

### Flip list

    A→B   fixed 3   broke 1   unchanged 99
      + 2026-09-11/160141.raw.jpg   expected=cat     A=nocat  B=cat    (FN fixed)
      - night/porch-ir-11.jpg       expected=nocat   A=nocat  B=cat    (new FP)

Aggregate scores rarely change anyone's mind; the list of frames that flipped does.

## Report

`runs/<iso>-<model-slug>/index.html`, with annotated JPEGs written beside it by the
existing `annotate()`, so the boxes are visible and not merely tallied.

Sections in order: **false positives, false negatives**, then true positives and true
negatives, then errors. FP and FN lead because they are the only two anyone looks at.
Each thumbnail is captioned with relative path, detection labels, ms, and the label
note if present. A per-directory table from `summary.byDirectory` sits at the top.

## Modules

| File | Purpose | Pure |
|---|---|---|
| `eval/corpus.ts` | recursive walk, load/merge/write `labels.json`, sha | yes, fs injected |
| `eval/metrics.ts` | confusion matrix, precision/recall/F1/F-beta, per-directory rollup, run diff, McNemar | yes |
| `eval/report.ts` | contact-sheet HTML, compare text | yes |
| `eval/cli.ts` | `parseArgs`, orchestration, LM Studio calls, file writes | no |

The split is the testing strategy: three of the four are pure and get `*.test.ts`
files beside them, matching the rest of the role. `cli.ts` stays thin enough to be
uninteresting, and the vision client is deliberately **not** mocked — running
`eval run` against LM Studio is itself the integration test, which is the point of the
exercise.

## Changes outside `src/eval/`

- `package.json`: add `"eval": "tsc && node dist/eval/cli.js"`; change `test` from
  `node --test dist/*.test.js` to `node --test dist` so discovery recurses into
  `dist/eval/`.
- `src/vision.ts`: `createVisionClient` accepts an optional `prompt`, defaulting to the
  exported `PROMPT`. No behaviour change for `index.ts`.
- `roles/doorbell/.gitignore`: add `eval/`.
- `roles/doorbell/.dockerignore`: add `eval`.
- `roles/doorbell/README.md`: an Eval section covering seeding, the label workflow, and
  what the verdict line does and does not claim.

The Dockerfile is unchanged. `src/eval/` ships in the image, which is a few kilobytes
and never executed; excluding it would mean a second tsconfig for no benefit.

## Testing

Unit tests, run by the existing `yarn test` with no LM Studio required:

- `corpus.test.ts` — recursive walk over a fixture tree; dotfiles and `._*` skipped;
  symlinked subdirectory followed; symlink cycle terminates; merge preserves existing
  labels, adds new files as `false`, and reports orphans; relative keys are POSIX-form
  on any platform; `labelsSha` is stable under key reordering.
- `metrics.test.ts` — confusion matrix including the error exclusion; precision, recall,
  F1 and F-beta against hand-computed values; the degenerate cases (no positives, no
  predictions) yield 0 rather than NaN; per-directory rollup; run diff classifies fixed,
  broke and unchanged; McNemar's exact p-value against known values, including the
  b = c = 0 case.
- `report.test.ts` — sections ordered FP, FN, TP, TN, errors; a run with no failures
  still renders; captions escape HTML.

Manual verification, which is the real acceptance test:

1. `cp -r` a day of raw frames into `eval/images/`, run `bootstrap`, correct the labels
   against `sheet.html`.
2. `run` against the current `gemma-3-12b-it-qat`, and read the contact sheet. The
   confusion matrix should roughly agree with what the annotated frames on gluster
   already show.
3. `run` against a second model, then `compare` the two and confirm the flip list names
   frames that visibly differ and the verdict reflects how few of them there are.
