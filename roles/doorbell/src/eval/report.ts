import { Labels } from './corpus.js';
import { ImageResult, RunDiff, RunFile, Scores } from './metrics.js';

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
table { border-collapse: collapse; margin: 1rem 0; font-size: 0.85rem; }
th, td { border: 1px solid #444; padding: 0.25rem 0.6rem; text-align: right; }
th:first-child, td:first-child { text-align: left; }
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
    const positives = keys.filter((key) => labels[key]?.cat).length;

    const figures = keys.map((key) => {
        const label = labels[key];
        const note = label?.note ? `<br>${escapeHtml(label.note)}` : '';
        return `<figure>
  <img class="${label?.cat ? 'cat' : ''}" src="images/${escapeHtml(key)}" loading="lazy" alt="">
  <figcaption>${label?.cat ? '🐈 cat' : '— nocat'}<br>${escapeHtml(key)}${note}</figcaption>
</figure>`;
    });

    return page('doorbell eval corpus', `<h1>Corpus</h1>
<p>${keys.length} images, ${positives} labelled cat. Red outline means <code>cat: true</code>.
Edit <code>labels.json</code> to correct.</p>
<div class="grid">
${figures.join('\n')}
</div>`);
}

function scoreRow(name: string, scores: Scores): string {
    return `<tr><td>${escapeHtml(name)}</td><td>${scores.tp}</td><td>${scores.fp}</td><td>${scores.fn}</td>` +
        `<td>${scores.tn}</td><td>${scores.errors}</td><td>${scores.precision.toFixed(3)}</td>` +
        `<td>${scores.recall.toFixed(3)}</td><td>${scores.f1.toFixed(3)}</td><td>${scores.fbeta.toFixed(3)}</td></tr>`;
}

function section(title: string, results: ImageResult[]): string {
    if (results.length === 0) return `<h2>${escapeHtml(title)} (0)</h2>`;

    const figures = results.map((item) => {
        // Annotated copies exist only where there were boxes to draw; everything else
        // points back at the untouched source image.
        const src = item.annotated ?? `../../images/${item.image}`;
        const labels = item.detections.map((detection) => detection.label).join(', ') || '—';
        const error = item.error ? `<br>${escapeHtml(item.error)}` : '';
        return `<figure>
  <img src="${escapeHtml(src)}" loading="lazy" alt="">
  <figcaption>${escapeHtml(item.image)}<br>${escapeHtml(labels)} · ${item.ms}ms${error}</figcaption>
</figure>`;
    });

    return `<h2>${escapeHtml(title)} (${results.length})</h2>
<div class="grid">
${figures.join('\n')}
</div>`;
}

export function renderReport(run: RunFile): string {
    const of = (outcome: ImageResult['outcome']) => run.results.filter((item) => item.outcome === outcome);

    const directories = Object.entries(run.summary.byDirectory)
        .map(([name, scores]) => scoreRow(name, scores))
        .join('\n');

    // False positives and false negatives lead: they are the only two anyone looks at.
    // Without it, a per-image ms is unreadable: frames in flight together each take
    // longer in wall clock than they would alone.
    const inFlight = run.concurrency ? ` (${run.concurrency} at a time)` : '';

    const body = `<h1>${escapeHtml(run.model)}</h1>
<p>${escapeHtml(run.startedAt)} · ${run.corpus.images} images, ${run.corpus.positives} cat ·
${(run.summary.totalMs / 1000).toFixed(1)}s${inFlight}<br>
prompt <code>${escapeHtml(run.promptSha.slice(0, 12))}</code> ·
labels <code>${escapeHtml(run.labelsSha.slice(0, 12))}</code></p>
<table>
<tr><th>scope</th><th>tp</th><th>fp</th><th>fn</th><th>tn</th><th>err</th>
<th>precision</th><th>recall</th><th>f1</th><th>f${run.summary.beta}</th></tr>
${scoreRow('all', run.summary)}
${directories}
</table>
${section('False positives', of('fp'))}
${section('False negatives', of('fn'))}
${section('True positives', of('tp'))}
${section('True negatives', of('tn'))}
${section('Errors', of('error'))}`;

    return page(`${run.model} — doorbell eval`, body);
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
}): string {
    const { a, b, diff, beta, p } = options;
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
        `A  ${a.model}  ${a.startedAt}`,
        `B  ${b.model}  ${b.startedAt}`,
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
    ].join('\n');
}
