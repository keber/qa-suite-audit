/**
 * report/html.js - Single file HTML renderer
 *
 * One self-contained document: no network, no build step, no dependency. It is
 * meant to be attached to a pipeline run or emailed to whoever asked how the
 * suite is doing, and it has to render years from now from the file alone.
 *
 * The design job here is to stop the total from being the only thing anyone
 * reads. A single number invites the reader to treat it as a fact about the
 * suite, when it is a reading of the suite through declared ceilings and
 * arguable thresholds. So the ceiling, the reason for it, and every calibrated
 * decision sit next to the score rather than in an appendix.
 */

'use strict';

const { buildModel } = require('./model.js');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render(input, verdict) {
  const m = buildModel(input, verdict);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Suite audit - ${escapeHtml(m.repo)}</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1b1b1f; --muted: #5f6368; --line: #e1e3e8;
    --card: #f7f8fa; --accent: #2b5cd9; --warn: #9a5b00; --bad: #b3261e;
    --fill: #2b5cd9; --empty: #d9dce3;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16171a; --fg: #e8eaed; --muted: #9aa0a6; --line: #2c2e33;
      --card: #1e2024; --accent: #7aa2f7; --warn: #e0a458; --bad: #f2837c;
      --fill: #7aa2f7; --empty: #34363c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px; background: var(--bg); color: var(--fg);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em;
       color: var(--muted); margin: 36px 0 12px; font-weight: 600; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 28px; }
  .headline { background: var(--card); border: 1px solid var(--line);
              border-radius: 10px; padding: 20px 22px; }
  .headline.fail { border-color: var(--bad); }
  .score { font-size: 38px; font-weight: 650; letter-spacing: -.02em; }
  .score small { font-size: 18px; color: var(--muted); font-weight: 400; }
  .status { display: inline-block; margin-left: 12px; padding: 3px 10px;
            border-radius: 999px; font-size: 12px; font-weight: 600;
            background: var(--bad); color: #fff; vertical-align: 6px; }
  .caveat { color: var(--muted); font-size: 13px; margin-top: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line);
           vertical-align: top; font-size: 14px; }
  th { color: var(--muted); font-weight: 600; font-size: 12px;
       text-transform: uppercase; letter-spacing: .05em; }
  td.num { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .meter { display: inline-flex; gap: 3px; margin-left: 8px; vertical-align: 1px; }
  .meter i { width: 9px; height: 9px; border-radius: 2px; background: var(--empty); }
  .meter i.on { background: var(--fill); }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 11px;
         font-weight: 600; margin-right: 5px; border: 1px solid var(--line); color: var(--muted); }
  .tag.bad { color: var(--bad); border-color: var(--bad); }
  .tag.warn { color: var(--warn); border-color: var(--warn); }
  .reason { color: var(--muted); font-size: 13px; margin-top: 6px; }
  .cites { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
           font-size: 11.5px; color: var(--muted); margin-top: 6px; word-break: break-all; }
  .panel { background: var(--card); border: 1px solid var(--line);
           border-left: 3px solid var(--warn); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
  .panel h3 { margin: 0 0 6px; font-size: 14px; }
  .panel p { margin: 4px 0; font-size: 13.5px; }
  footer { margin-top: 44px; padding-top: 16px; border-top: 1px solid var(--line);
           color: var(--muted); font-size: 12px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  @media (max-width: 560px) { th:nth-child(4), td:nth-child(4) { display: none; } }
</style>
</head>
<body>
<main>

  <h1>Suite audit - ${escapeHtml(m.repo)}</h1>
  <p class="sub">
    adapter <code>${escapeHtml(m.adapter.name)}</code> &middot;
    evidence <code>${escapeHtml(m.shortDigest)}</code> &middot;
    ${m.suiteFiles} test file(s)
  </p>
${m.suiteType ? `  <p class="sub">
    suite type <strong>${escapeHtml(m.suiteType.type)}</strong>${m.suiteType.byDirectory.length
      ? ` &middot; ${m.suiteType.byDirectory.map(e => `<code>${escapeHtml(e.directory)}</code> ${escapeHtml(e.type)}`).join(' &middot; ')}`
      : ''}
  </p>
` : ''}
  <div class="headline${m.eliminated ? ' fail' : ''}">
    <div class="score">${m.obtained}<small> / ${m.attainable}</small>${
      m.eliminated ? `<span class="status">DOES NOT PASS</span>` : ''
    }</div>
    ${m.eliminated
      ? `<p class="caveat">Eliminated: dimension ${m.eliminatedBy.join(' and ')} scored 0. The rubric treats those as disqualifying regardless of the total.</p>`
      : ''}
    <p class="caveat">
      This reads the repository only. ${m.attainable} of the rubric's 21 points are reachable at all;
      the rest assert facts that live in run history and CI policy. The source rubric's verdict
      bands are not applied, because they assume evidence this audit does not have.
    </p>
  </div>

  <h2>Dimensions</h2>
  <table>
    <thead>
      <tr><th>#</th><th>Dimension</th><th class="num">Level</th><th>Ceiling</th></tr>
    </thead>
    <tbody>
${m.dimensions.map(d => dimensionRow(d)).join('\n')}
    </tbody>
  </table>

${m.risks ? riskPanel(m) : ''}
${m.calibratedDecisions.length ? calibrationPanel(m) : ''}
${m.lowConfidence.length ? `
  <h2>Unsettled</h2>
  <div class="panel">
    <p>Dimension(s) ${m.lowConfidence.join(', ')} were assigned at low confidence: the evidence
    did not settle the question, so the lowest permitted level was taken. Reading those tests by
    hand is the way to move them.</p>
  </div>` : ''}

${m.thresholdObjections.length ? `
  <h2>Threshold objections</h2>
  <div class="panel">
    ${m.thresholdObjections.map(o => `<p>${escapeHtml(typeof o === 'string' ? o : JSON.stringify(o))}</p>`).join('\n')}
  </div>` : ''}

${m.notes ? `
  <h2>Notes</h2>
  <div class="panel"><p>${escapeHtml(m.notes)}</p></div>` : ''}

  <footer>
    Evidence digest <code>${escapeHtml(m.digest)}</code>.
    A verdict is bound to one digest: if the suite changes, this report describes a repository
    state that no longer exists and must be regenerated rather than edited.
  </footer>

</main>
</body>
</html>
`;
}

function dimensionRow(d) {
  const meter = Array.from({ length: d.ceiling }, (_, i) =>
    `<i class="${d.level !== null && i < d.level ? 'on' : ''}"></i>`).join('');

  const tags = [];
  if (d.eliminatory && d.level === 0) tags.push('<span class="tag bad">eliminatory</span>');
  if (d.decidedByCalibration)         tags.push('<span class="tag warn">calibrated</span>');
  if (d.determined !== null)          tags.push('<span class="tag">settled by evidence</span>');
  if (d.confidence === 'low')         tags.push('<span class="tag warn">low confidence</span>');

  return `      <tr>
        <td class="num">D${d.n}</td>
        <td>
          <strong>${escapeHtml(d.name)}</strong>
          ${tags.join(' ')}
          ${d.reasoning ? `<div class="reason">${escapeHtml(d.reasoning)}</div>` : ''}
          ${d.citations.length ? `<div class="cites">cites ${escapeHtml(d.citations.join(', '))}</div>` : ''}
          ${d.observations.length ? `<div class="cites">read ${escapeHtml(d.observations.join(', '))}</div>` : ''}
        </td>
        <td class="num">${d.level === null ? '?' : d.level} / ${d.ceiling}
          <span class="meter">${meter}</span></td>
        <td class="reason">${escapeHtml(d.ceilingReason)}</td>
      </tr>`;
}

function riskPanel(m) {
  const r = m.risks;
  const severities = Object.entries(r.bySeverity)
    .map(([k, v]) => `<span class="tag">${escapeHtml(k)} ${v}</span>`).join(' ');

  return `
  <h2>Risk register</h2>
  <div class="panel">
    <h3>${r.covered} of ${r.total} risks have a test that cites them</h3>
    <p>${severities}</p>
    <p class="reason">
      Counted apart from rule coverage, because a rule is something the system is specified
      to do and a risk is something an analyst found it might do wrong. This figure is
      <strong>inferential</strong>: a test file cites a risk id, which is not the same as a
      test asserting the behaviour behind it.
    </p>
    <p class="cites">${escapeHtml(r.register)}</p>
    ${r.citingFiles.length ? `<p class="cites">${r.citingFiles
      .map(f => `${escapeHtml(f.risks.join(', '))} &lt;- ${escapeHtml(f.file)}`).join('<br>')}</p>` : ''}
    ${r.uncovered.length ? `<p class="reason">Uncited: ${escapeHtml(r.uncovered.join(', '))}</p>` : ''}
  </div>`;
}

function calibrationPanel(m) {
  return `
  <h2>Decided by calibration, not by the rubric</h2>
${m.calibratedDecisions.map(c => `  <div class="panel">
    <h3>D${c.dimension} ${escapeHtml(c.name)}</h3>
${c.constraints.map(k => `    <p>${escapeHtml(k.observed)}</p>
    <p><strong>${escapeHtml(k.effect)}</strong></p>
    <p class="reason">${escapeHtml(k.rule)}</p>`).join('\n')}
  </div>`).join('\n')}
  <div class="panel">
    <p>These boundaries are choices, recorded in <code>thresholds.json</code> with the rubric text
    they interpret and what moving them costs. Change a value there and this result changes with it.
    That is the point: a line somebody drew by hand should be visible to whoever reads the number.</p>
  </div>`;
}

module.exports = { render };
