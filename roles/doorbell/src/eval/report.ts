import { Labels, hasCat, isBox, pendingLabels } from './corpus.js';
import { HitDiff, ImageResult, Localization, RunDiff, RunFile, Scores, bestMatch } from './metrics.js';

const SIGNIFICANT = 0.05;

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const STYLE = `
body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; background: #111; color: #eee; }
h1, h2 { font-weight: 600; }
.grid { display: flex; flex-wrap: wrap; gap: 1rem; }
figure { margin: 0; width: 14rem; }
img { width: 100%; border-radius: 4px; display: block; background: #222; }
figcaption { font-size: 0.75rem; color: #aaa; word-break: break-all; margin-top: 0.25rem; }
.cat { outline: 3px solid #e33; }
.unlabelled { outline: 3px dashed #eb3; }
table { border-collapse: collapse; margin: 1rem 0; font-size: 0.85rem; }
th, td { border: 1px solid #444; padding: 0.25rem 0.6rem; text-align: right; }
th:first-child, td:first-child { text-align: left; }
pre { white-space: pre-wrap; background: #1a1a1a; border: 1px solid #333; border-radius: 4px; padding: 0.75rem; font-size: 0.8rem; max-width: 60rem; }
`;

function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>
${body}
</body>
</html>
`;
}

/**
 * The labelling sheet. Images are referenced relative to the corpus root, where
 * this file is written, so nothing is copied.
 */
export function renderSheet(labels: Labels): string {
    const keys = Object.keys(labels).sort();
    const positives = keys.filter((key) => hasCat(labels[key])).length;
    const unlabelled = new Set(pendingLabels(labels));

    const figures = keys.map((key) => {
        const label = labels[key];
        const note = label?.note ? `<br>${escapeHtml(label.note)}` : '';
        const [className, caption] = unlabelled.has(key) ? ['unlabelled', '? unlabelled']
            : hasCat(label) ? ['cat', '🐈 cat']
            : ['', '— nocat'];
        return `<figure>
  <img class="${className}" src="images/${escapeHtml(key)}" loading="lazy" alt="">
  <figcaption>${caption}<br>${escapeHtml(key)}${note}</figcaption>
</figure>`;
    });

    return page('doorbell eval corpus', `<h1>Corpus</h1>
<p>${keys.length} images, ${positives} labelled cat, ${unlabelled.size} unlabelled. Red outline means a box,
dashed amber means no box yet. Run <code>yarn eval annotate</code> to draw or correct them.</p>
<div class="grid">
${figures.join('\n')}
</div>`);
}

const ANNOTATOR_STYLE = `
body { margin: 0; padding: 1rem; height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; gap: 0.75rem; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; }
header .key { font-family: ui-monospace, monospace; font-size: 0.85rem; }
.hint { color: #eb3; }
.status { color: #aaa; font-size: 0.85rem; margin-left: auto; }
button { background: #222; color: #eee; border: 1px solid #555; border-radius: 4px; padding: 0.3rem 0.8rem; font: inherit; cursor: pointer; }
button:hover { border-color: #999; }
button.primary { border-color: #3a7; }
.stage { flex: 1; min-height: 0; display: flex; justify-content: center; align-items: center; }
.frame { position: relative; line-height: 0; cursor: crosshair; user-select: none; touch-action: none; }
.frame img { border-radius: 0; }
.box { position: absolute; border: 2px solid #3d8; box-shadow: 0 0 0 1px #000; pointer-events: none; }
.box[hidden] { display: none; }
kbd { border: 1px solid #555; border-radius: 3px; padding: 0 0.3rem; font-size: 0.75rem; }
`;

// Runs in the browser. Coordinates are kept in the source image's own pixels and
// converted to and from the displayed size only at the edges, so a resized window
// never changes what is saved.
const ANNOTATOR_SCRIPT = `
const frames = JSON.parse(document.getElementById('frames').textContent);
const img = document.querySelector('.frame img');
const frame = document.querySelector('.frame');
const overlay = document.querySelector('.box');
const visited = new Set();
let index = 0;
let drag = null;

const boxed = () => frames.filter((f) => f.box).length;

function scale() {
    return img.naturalWidth / img.getBoundingClientRect().width;
}

function render() {
    const current = frames[index];
    document.querySelector('.key').textContent = current.key;
    document.querySelector('.position').textContent = (index + 1) + ' / ' + frames.length;
    document.querySelector('.hint').textContent = current.hint === true && !current.box ? 'labelled cat — needs a box' : '';
    document.querySelector('.status').textContent =
        boxed() + ' boxed · ' + visited.size + ' unsaved';

    const box = drag ? drag.box : current.box;
    overlay.hidden = !box || !img.naturalWidth;
    if (overlay.hidden) return;
    const s = scale();
    overlay.style.left = box.xMin / s + 'px';
    overlay.style.top = box.yMin / s + 'px';
    overlay.style.width = (box.xMax - box.xMin) / s + 'px';
    overlay.style.height = (box.yMax - box.yMin) / s + 'px';
}

function show(next) {
    index = Math.max(0, Math.min(frames.length - 1, next));
    visited.add(frames[index].key);
    img.src = 'images/' + frames[index].key.split('/').map(encodeURIComponent).join('/');
    // The mount is slow; fetch the neighbour while this one is being looked at.
    if (frames[index + 1]) new Image().src = 'images/' + frames[index + 1].key.split('/').map(encodeURIComponent).join('/');
    render();
}

function point(event) {
    const rect = img.getBoundingClientRect();
    const s = scale();
    const clamp = (value, max) => Math.max(0, Math.min(max, value));
    return {
        x: clamp((event.clientX - rect.left) * s, img.naturalWidth),
        y: clamp((event.clientY - rect.top) * s, img.naturalHeight),
    };
}

function boxBetween(a, b) {
    return {
        xMin: Math.round(Math.min(a.x, b.x)),
        yMin: Math.round(Math.min(a.y, b.y)),
        xMax: Math.round(Math.max(a.x, b.x)),
        yMax: Math.round(Math.max(a.y, b.y)),
    };
}

function edit(box) {
    frames[index].box = box;
    visited.add(frames[index].key);
    render();
}

frame.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !img.naturalWidth) return;
    frame.setPointerCapture(event.pointerId);
    const start = point(event);
    drag = { start, box: boxBetween(start, start) };
    render();
});

frame.addEventListener('pointermove', (event) => {
    if (!drag) return;
    drag.box = boxBetween(drag.start, point(event));
    render();
});

frame.addEventListener('pointerup', () => {
    if (!drag) return;
    const box = drag.box;
    drag = null;
    // A click is not a box: anything this small is a slip, and keeps what was there.
    if (box.xMax - box.xMin >= 4 && box.yMax - box.yMin >= 4) edit(box);
    else render();
});

// Scaled up to fill the stage, not just down: a 512x384 frame drawn at its own size
// is too small to put a box on to the pixel.
function fit() {
    if (!img.naturalWidth) return;
    const stage = document.querySelector('.stage');
    const s = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight);
    img.style.width = Math.floor(img.naturalWidth * s) + 'px';
    img.style.height = Math.floor(img.naturalHeight * s) + 'px';
    render();
}

img.addEventListener('load', fit);
window.addEventListener('resize', fit);

async function save() {
    const button = document.querySelector('.save');
    const boxes = {};
    for (const key of visited) boxes[key] = frames.find((f) => f.key === key).box;
    button.disabled = true;
    try {
        const response = await fetch('labels', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ boxes }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || response.statusText);
        visited.clear();
        render();
        document.querySelector('.status').textContent = 'saved ' + body.saved + ' · ' + boxed() + ' boxed';
    } catch (error) {
        document.querySelector('.status').textContent = 'save failed: ' + error.message;
    } finally {
        button.disabled = false;
    }
}

document.querySelector('.prev').addEventListener('click', () => show(index - 1));
document.querySelector('.next').addEventListener('click', () => show(index + 1));
document.querySelector('.clear').addEventListener('click', () => edit(null));
document.querySelector('.save').addEventListener('click', save);

document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'ArrowLeft') show(index - 1);
    else if (event.key === 'ArrowRight') show(index + 1);
    else if (event.key === 'Delete' || event.key === 'Backspace') edit(null);
    else return;
    event.preventDefault();
});

window.addEventListener('beforeunload', (event) => {
    if (visited.size > 0) event.preventDefault();
});

show(0);
`;

/**
 * The annotator, served by `yarn eval annotate`. Every frame passed is shown; on
 * save, only the ones actually looked at are sent, so a frame never brought up
 * keeps its label rather than being recorded as having no cat.
 */
export function renderAnnotator(labels: Labels, keys: string[]): string {
    const frames = keys.map((key) => {
        const label = labels[key];
        return {
            key,
            box: isBox(label?.box) ? label.box : null,
            // Only meaningful until the frame is boxed: after that the box is the verdict.
            hint: label?.box === undefined && typeof label?.cat === 'boolean' ? label.cat : null,
        };
    });

    // JSON is not HTML-safe inside a script element: escaping "<" keeps a key from
    // closing the block, and JSON.parse reads \u003c back as the same character.
    const data = JSON.stringify(frames).replace(/</g, '\\u003c');

    return page('annotate — doorbell eval', `<style>${ANNOTATOR_STYLE}</style>
<header>
  <span class="position"></span>
  <span class="key"></span>
  <span class="hint"></span>
  <span class="status"></span>
</header>
<div class="stage"><div class="frame"><img alt="" draggable="false"><div class="box" hidden></div></div></div>
<footer>
  <button class="prev">← prev</button>
  <button class="next">next →</button>
  <button class="clear">clear <kbd>Del</kbd></button>
  <button class="save primary">save</button>
  <span class="status-help">drag to draw; drawing again replaces the box</span>
</footer>
<script type="application/json" id="frames">${data}</script>
<script>${ANNOTATOR_SCRIPT}</script>`);
}

function scoreRow(name: string, scores: Scores): string {
    return `<tr><td>${escapeHtml(name)}</td><td>${scores.tp}</td><td>${scores.fp}</td><td>${scores.fn}</td>` +
        `<td>${scores.tn}</td><td>${scores.errors}</td><td>${scores.precision.toFixed(3)}</td>` +
        `<td>${scores.recall.toFixed(3)}</td><td>${scores.f1.toFixed(3)}</td><td>${scores.fbeta.toFixed(3)}</td></tr>`;
}

function signed(value: number, digits: number): string {
    return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function localizationLine(scores: Localization): string {
    return `hit@${scores.threshold} ${scores.hits}/${scores.frames} (${scores.hitRate.toFixed(3)}) · ` +
        `mean IoU ${scores.meanIou.toFixed(3)} over ${scores.found} found · ` +
        `centre offset dx ${signed(scores.meanDx, 1)} dy ${signed(scores.meanDy, 1)}px`;
}

function section(title: string, results: ImageResult[], runDir: string): string {
    if (results.length === 0) return `<h2>${escapeHtml(title)} (0)</h2>`;

    const figures = results.map((item) => {
        // Annotated copies exist only where there were boxes to draw; everything else
        // points back at the untouched source image.
        const src = item.annotated ? `${runDir}/${item.annotated}` : `../images/${item.image}`;
        const labels = item.detections.map((detection) => detection.label).join(', ') || '—';
        const error = item.error ? `<br>${escapeHtml(item.error)}` : '';
        // Only a cat frame has a box to overlap, and only a run that kept boxes can say.
        const overlap = item.truth && item.outcome !== 'error'
            ? ` · IoU ${(bestMatch(item.truth, item.boxes ?? [])?.iou ?? 0).toFixed(2)}`
            : '';
        return `<figure>
  <img src="${escapeHtml(src)}" loading="lazy" alt="">
  <figcaption>${escapeHtml(item.image)}<br>${escapeHtml(labels)}${overlap} · ${item.ms}ms${error}</figcaption>
</figure>`;
    });

    return `<h2>${escapeHtml(title)} (${results.length})</h2>
<div class="grid">
${figures.join('\n')}
</div>`;
}

/**
 * Written beside the run's JSON in runs/, so `runDir` — the run's own folder of
 * annotated copies — is the sibling directory images are linked through.
 */
export function renderReport(run: RunFile, runDir: string): string {
    const of = (outcome: ImageResult['outcome']) => run.results.filter((item) => item.outcome === outcome);

    const directories = Object.entries(run.summary.byDirectory)
        .map(([name, scores]) => scoreRow(name, scores))
        .join('\n');

    // False positives and false negatives lead: they are the only two anyone looks at.
    // Without it, a per-image ms is unreadable: frames in flight together each take
    // longer in wall clock than they would alone.
    const inFlight = run.concurrency ? ` (${run.concurrency} at a time)` : '';
    const upscaled = run.upscale ? ` · ${run.upscale}× upscale` : '';
    const subset = run.only ? ` · only ${run.only.map((pattern) => `<code>${escapeHtml(pattern)}</code>`).join(', ')}` : '';

    const body = `<h1>${escapeHtml(run.model)}</h1>
<p>${escapeHtml(run.startedAt)} · ${run.corpus.images} images, ${run.corpus.positives} cat${subset} ·
${(run.summary.totalMs / 1000).toFixed(1)}s${inFlight}${upscaled}<br>
prompt <code>${escapeHtml(run.promptSha.slice(0, 12))}</code> ·
labels <code>${escapeHtml(run.labelsSha.slice(0, 12))}</code></p>
<pre>${escapeHtml(run.prompt)}</pre>
<table>
<tr><th>scope</th><th>tp</th><th>fp</th><th>fn</th><th>tn</th><th>err</th>
<th>precision</th><th>recall</th><th>f1</th><th>f${run.summary.beta}</th></tr>
${scoreRow('all', run.summary)}
${directories}
</table>
${run.summary.localization ? `<p>${localizationLine(run.summary.localization)}<br>
offsets are the best box's centre minus the labelled one's, in source pixels; negative dy is a box above the cat</p>` : ''}
${section('False positives', of('fp'), runDir)}
${section('False negatives', of('fn'), runDir)}
${section('True positives', of('tp'), runDir)}
${section('True negatives', of('tn'), runDir)}
${section('Errors', of('error'), runDir)}`;

    return page(`${run.model} — doorbell eval`, body);
}

function upscaleNote(run: RunFile): string {
    return run.upscale ? `  ${run.upscale}× upscale` : '';
}

function summaryLine(name: string, run: RunFile): string {
    const s = run.summary;
    return `${name.padEnd(10)} tp=${String(s.tp).padStart(3)} fp=${String(s.fp).padStart(3)} ` +
        `fn=${String(s.fn).padStart(3)} tn=${String(s.tn).padStart(3)} err=${String(s.errors).padStart(3)}  ` +
        `P=${s.precision.toFixed(3)} R=${s.recall.toFixed(3)} F1=${s.f1.toFixed(3)} F${s.beta}=${s.fbeta.toFixed(3)}`;
}

export function renderCompare(options: {
    a: RunFile;
    b: RunFile;
    diff: RunDiff;
    beta: number;
    p: number;
    /** Absent when either run predates boxed labels. */
    hits?: HitDiff & { p: number };
}): string {
    const { a, b, diff, beta, p, hits } = options;
    const delta = b.summary.fbeta - a.summary.fbeta;
    const fixed = diff.fixed.length;
    const broke = diff.broke.length;

    const flips = [...diff.fixed, ...diff.broke]
        .sort((one, two) => one.image.localeCompare(two.image))
        .map((flip) => {
            const sign = flip.kind === 'fixed' ? '+' : '-';
            const was = flip.expected ? 'FN' : 'FP';
            const note = flip.kind === 'fixed' ? `${was} fixed` : `new ${was}`;
            return `  ${sign} ${flip.image.padEnd(40)} expected=${flip.expected ? 'cat  ' : 'nocat'} ` +
                `A=${flip.a ? 'cat  ' : 'nocat'} B=${flip.b ? 'cat  ' : 'nocat'}  (${note})`;
        });

    // The direction has to come from the same thing the p-value tested — the flip
    // asymmetry — not from the F-beta delta. They can disagree, and on a corpus with
    // no true positives F-beta is structurally zero and carries no direction at all.
    const winner = fixed > broke ? 'B' : 'A';
    const model = fixed > broke ? b.model : a.model;
    const verdict = p <= SIGNIFICANT && fixed !== broke
        ? `verdict: ${winner} better (${model}) — F${beta} ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} ` +
          `(${a.summary.fbeta.toFixed(3)} → ${b.summary.fbeta.toFixed(3)}), ` +
          `${fixed} fixed / ${broke} broke, McNemar p=${p.toFixed(4)}`
        : `verdict: no clear winner — F${beta} ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}, ` +
          `${fixed} fixed / ${broke} broke, McNemar p=${p.toFixed(4)} (n too small to call)`;

    return [
        `A  ${a.model}  ${a.startedAt}${upscaleNote(a)}`,
        `B  ${b.model}  ${b.startedAt}${upscaleNote(b)}`,
        '',
        summaryLine('A', a),
        summaryLine('B', b),
        '',
        `A→B   fixed ${fixed}   broke ${broke}   unchanged ${diff.unchanged}   excluded ${diff.excluded}`,
        ...flips,
        '',
        verdict,
        `ranking uses F${beta}: a false positive latches the sensor wrong for ~90s, a false negative is usually absorbed.`,
        '',
        ...localizationSection(a, b, hits),
    ].join('\n');
}

function localizationSection(a: RunFile, b: RunFile, hits: (HitDiff & { p: number }) | undefined): string[] {
    const scoresA = a.summary.localization;
    const scoresB = b.summary.localization;
    if (!scoresA || !scoresB || !hits) return [];

    const row = (name: string, scores: Localization) =>
        `${name.padEnd(10)} hit@${scores.threshold} ${String(scores.hits).padStart(3)}/${scores.frames}  ` +
        `mean IoU ${scores.meanIou.toFixed(3)}  dx ${signed(scores.meanDx, 1)} dy ${signed(scores.meanDy, 1)}px`;

    return [
        `localization, against the labelled box (IoU ≥ ${scoresA.threshold} locates the cat)`,
        row('A', scoresA),
        row('B', scoresB),
        '',
        `located   fixed ${hits.fixed.length}   broke ${hits.broke.length}   unchanged ${hits.unchanged}   excluded ${hits.excluded}`,
        ...hits.fixed.map((image) => `  + ${image}`),
        ...hits.broke.map((image) => `  - ${image}`),
        '',
        `mean IoU change ${signed(hits.meanIouDelta, 3)} (B − A, a miss as 0), McNemar p=${hits.p.toFixed(4)}`,
        '',
    ];
}
