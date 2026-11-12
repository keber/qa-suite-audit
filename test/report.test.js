/**
 * report.test.js - Tests for the three renderers.
 *
 * A report is the only part of this instrument most people will ever see, so
 * the things it must never do quietly are the things tested hardest: hide an
 * elimination, hide that a number came from a calibrated threshold, or present
 * a ceiling-limited score as if it were out of 21.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const list   = require('../src/report/list.js');
const html   = require('../src/report/html.js');
const allure = require('../src/report/allure.js');
const { buildModel } = require('../src/report/model.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIGEST = 'c'.repeat(64);

const INPUT = {
  schema: 'judgment-input/v1',
  repo: 'demo-repo',
  adapter: { name: 'qa-framework', description: 'x', specsRoot: 'qa/01-specifications' },
  evidenceDigest: DIGEST,
  attainable: 16,
  suiteFiles: ['tests/a.spec.ts', 'tests/b.spec.ts'],
  dimensions: [
    { dimension: 1, name: 'Oracle', eliminatory: true, ceiling: 3, ceilingReason: 'needs a rule inventory', bounds: { min: 0, max: 1 }, determined: null, constraints: [{ threshold: 'D1.traceability-floor', kind: 'literal', rule: 'r', observed: 'covered rules ratio 0', effect: 'capped at 1' }], mustCite: ['D1.spec-linkage'], question: 'q' },
    { dimension: 2, name: 'Sensitivity', eliminatory: true, ceiling: 3, ceilingReason: 'needs mutation evidence', bounds: { min: 0, max: 0 }, determined: 0, constraints: [{ threshold: 'D2.systemic-assertless', kind: 'calibration', rule: 'tests that cannot fail are a characteristic', observed: 'assertless 5.4% (limit 5%)', effect: 'capped at 0' }], mustCite: ['D2.assertless-tests'], question: null },
    { dimension: 3, name: 'Determinism', eliminatory: false, ceiling: 2, ceilingReason: 'run behavior', bounds: { min: 0, max: 2 }, determined: null, constraints: [], mustCite: ['D3.fixed-waits'], question: 'q' },
    { dimension: 4, name: 'Diagnosis', eliminatory: false, ceiling: 3, ceilingReason: 'none', bounds: { min: 0, max: 3 }, determined: null, constraints: [], mustCite: ['D4.failure-context'], question: 'q' },
    { dimension: 5, name: 'Rule coverage', eliminatory: false, ceiling: 2, ceilingReason: 'needs exclusions written down', bounds: { min: 0, max: 2 }, determined: null, constraints: [], mustCite: ['D5.covered-rules'], question: 'q' },
    { dimension: 6, name: 'Life in CI', eliminatory: false, ceiling: 1, ceilingReason: 'server policy', bounds: { min: 1, max: 1 }, determined: 1, constraints: [{ threshold: 'D6.runs-the-suite', kind: 'literal', rule: 'r', observed: '1 pipeline', effect: 'determined at 1' }], mustCite: ['D6.suite-invocation'], question: null },
    { dimension: 7, name: 'Maintainability', eliminatory: false, ceiling: 2, ceilingReason: 'needs history', bounds: { min: 0, max: 2 }, determined: null, constraints: [], mustCite: ['D7.selector-mix'], question: 'q' },
  ],
  items: { source: {}, rules: {}, pipelines: {} },
};

const REASON = 'The expected values trace to the cited rule and were checked against the specification text.';

function verdict(overrides = {}) {
  const levels = [
    { dimension: 1, level: 0, confidence: 'high',   citations: ['D1.spec-linkage'], observations: ['tests/a.spec.ts:10'], reasoning: REASON },
    { dimension: 2, level: 0, confidence: 'high',   citations: ['D2.assertless-tests'], observations: [], reasoning: REASON },
    { dimension: 3, level: 1, confidence: 'medium', citations: ['D3.fixed-waits'], observations: [], reasoning: REASON },
    { dimension: 4, level: 2, confidence: 'medium', citations: ['D4.failure-context'], observations: [], reasoning: REASON },
    { dimension: 5, level: 0, confidence: 'high',   citations: ['D5.covered-rules'], observations: [], reasoning: REASON },
    { dimension: 6, level: 1, confidence: 'high',   citations: ['D6.suite-invocation'], observations: [], reasoning: REASON },
    { dimension: 7, level: 1, confidence: 'medium', citations: ['D7.selector-mix'], observations: [], reasoning: REASON },
  ];
  return {
    schema: 'verdict/v1', repo: 'demo-repo', evidenceDigest: DIGEST, levels,
    obtained: levels.reduce((n, l) => n + l.level, 0), attainable: 16,
    eliminated: true, eliminatedBy: [1, 2], thresholdObjections: [], notes: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

test('the model computes the gap to ceiling, not just the level', (t) => {
  const m = buildModel(INPUT, verdict());
  const d4 = m.dimensions.find(d => d.n === 4);

  assert.equal(d4.level, 2);
  assert.equal(d4.gapToCeiling, 1, 'a reader should not have to subtract');
});

test('the model marks which dimensions a calibrated threshold decided', (t) => {
  const m = buildModel(INPUT, verdict());
  assert.deepEqual(m.calibratedDecisions.map(c => c.dimension), [2]);
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test('the terminal report leads with the elimination', (t) => {
  const text = list.render(INPUT, verdict());
  const headline = text.split('\n').slice(0, 8).join('\n');

  assert.match(headline, /DOES NOT PASS/);
  assert.match(headline, /eliminated by dimension 1 and 2/);
});

test('the terminal report never shows the score out of 21', (t) => {
  // The rubric has 21 points; v1 can reach 16. Printing 5/21 would tell the
  // reader the suite lost points that were never available.
  const text = list.render(INPUT, verdict());

  assert.match(text, /5\/16/);
  assert.ok(!/\/21\b/.test(text.replace(/16 of 21 points/, '')), 'only the explicit scope sentence may mention 21');
});

test('the terminal report names every calibrated decision', (t) => {
  const text = list.render(INPUT, verdict());

  assert.match(text, /DECIDED BY CALIBRATION, NOT BY THE RUBRIC TEXT/);
  assert.match(text, /assertless 5\.4%/);
  assert.match(text, /thresholds\.json/);
});

test('low confidence is surfaced, not buried in a field', (t) => {
  const v = verdict();
  v.levels[2].confidence = 'low';
  assert.match(list.render(INPUT, v), /LOW CONFIDENCE on dimension\(s\) 3/);
});

// ---------------------------------------------------------------------------
// html
// ---------------------------------------------------------------------------

test('the html report is self contained', (t) => {
  // It gets attached to a pipeline run and opened years later. A stylesheet or
  // a script fetched from anywhere would eventually render it blank.
  const page = html.render(INPUT, verdict());

  assert.ok(!/https?:\/\//.test(page), 'no external resource may be referenced');
  assert.ok(!/<script/i.test(page), 'no script is needed to read a report');
  assert.match(page, /<style>/);
});

test('the html report escapes content that came from a repository', (t) => {
  // Repo names, reasoning and observations all originate outside this tool.
  const v = verdict();
  v.levels[0].reasoning = 'Broke on <img src=x onerror="alert(1)"> in the grid';

  const page = html.render({ ...INPUT, repo: '<script>alert(1)</script>' }, v);

  assert.ok(!page.includes('<img src=x'), 'reasoning must be escaped');
  assert.ok(!page.includes('<script>alert(1)</script>'), 'the repo name must be escaped');
  assert.match(page, /&lt;script&gt;/);
});

test('the html report carries the full digest and says a verdict is bound to it', (t) => {
  const page = html.render(INPUT, verdict());

  assert.ok(page.includes(DIGEST));
  assert.match(page, /no longer exists/);
});

test('the html report states the scope next to the score', (t) => {
  const page = html.render(INPUT, verdict());
  assert.match(page, /reads the repository only/);
  assert.match(page, /bands are not applied/);
});

// ---------------------------------------------------------------------------
// allure
// ---------------------------------------------------------------------------

test('allure ids are stable for the same evidence', (t) => {
  // Re-rendering an audit must not invent a new run in the dashboard.
  const a = allure.build(INPUT, verdict(), { timestamp: 1 });
  const b = allure.build(INPUT, verdict(), { timestamp: 2 });

  assert.deepEqual(a.map(f => f.name).sort(), b.map(f => f.name).sort());
});

test('allure history ids survive a change in the evidence', (t) => {
  // This is what makes a trend line possible: the same dimension must line up
  // across runs even though the evidence digest moved.
  const first  = allure.build(INPUT, verdict(), { timestamp: 1 });
  const second = allure.build({ ...INPUT, evidenceDigest: 'd'.repeat(64) }, { ...verdict(), evidenceDigest: 'd'.repeat(64) }, { timestamp: 1 });

  const historyOf = (files) => files
    .filter(f => f.name.endsWith('-result.json'))
    .map(f => JSON.parse(f.body))
    .sort((x, y) => x.name.localeCompare(y.name))
    .map(r => r.historyId);

  assert.deepEqual(historyOf(first), historyOf(second));
  assert.notDeepEqual(first.map(f => f.name), second.map(f => f.name), 'but the run itself is new');
});

test('allure severity carries what a binary status cannot', (t) => {
  const files = allure.build(INPUT, verdict(), { timestamp: 1 });
  const results = files.filter(f => f.name.endsWith('-result.json')).map(f => JSON.parse(f.body));
  const byName = Object.fromEntries(results.map(r => [r.name, r]));

  const severity = (name) => byName[name].labels.find(l => l.name === 'severity').value;

  assert.equal(byName['D1 Oracle'].status, 'failed');
  assert.equal(severity('D1 Oracle'), 'blocker', 'eliminatory at zero');
  assert.equal(severity('D5 Rule coverage'), 'critical', 'zero but not eliminatory');
  assert.equal(severity('D3 Determinism'), 'normal', 'below its ceiling');
  assert.equal(severity('D6 Life in CI'), 'trivial', 'at its ceiling');
});

test('an allure result records the level and its reachable ceiling', (t) => {
  // A dimension sitting at 1 of 3 is green in Allure. Without the parameters a
  // reader cannot tell it apart from one at its ceiling.
  const files = allure.build(INPUT, verdict(), { timestamp: 1 });
  const d3 = files.filter(f => f.name.endsWith('-result.json'))
    .map(f => JSON.parse(f.body)).find(r => r.name === 'D3 Determinism');

  const params = Object.fromEntries(d3.parameters.map(p => [p.name, p.value]));
  assert.equal(params.level, '1');
  assert.equal(params.ceiling, '2');
  assert.match(d3.statusDetails.message, /of a reachable 2/);
});

test('the allure environment records the scope and that source bands were not applied', (t) => {
  const env = allure.build(INPUT, verdict(), { timestamp: 1 }).find(f => f.name === 'environment.properties').body;

  assert.match(env, /score=5\/16/);
  assert.match(env, /source\.rubric\.bands\.applied=false/);
  assert.match(env, /repository evidence only/);
});

test('a repository with no risk register shows no risk section', (t) => {
  assert.ok(!/RISK REGISTER/.test(list.render(INPUT, verdict())));
  assert.ok(!/Risk register/.test(html.render(INPUT, verdict())));
});

test('a risk register is reported next to the score, never folded into it', (t) => {
  const withRisks = {
    ...INPUT,
    items: {
      ...INPUT.items,
      rules: {
        ...INPUT.items.rules,
        'D1.risk-inventory': { present: true, register: 'qa/01-specifications/_risks.md', risks: 20, bySeverity: { ALTA: 7, MEDIA: 8, BAJA: 5 } },
        'D5.risk-coverage': { count: 3, of: 20, ratio: 0.15, evidenceClass: 'inferential', covered: ['R-02'], uncovered: ['R-01'], citingFiles: [{ file: 'tests/a.spec.ts', risks: ['R-02'] }] },
      },
    },
  };

  const text = list.render(withRisks, verdict());
  assert.match(text, /RISK REGISTER\s+3\/20/);
  assert.match(text, /inferential|not the same as a test asserting/);
  assert.match(text, /5\/16/, 'the score itself is untouched');

  const page = html.render(withRisks, verdict());
  assert.match(page, /3 of 20 risks/);
  assert.match(page, /inferential/);
  assert.match(page, /Counted apart from rule coverage/);
});
