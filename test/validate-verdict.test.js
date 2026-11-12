/**
 * validate-verdict.test.js - Tests for the verdict validator.
 *
 * Each test below corresponds to a way a generated verdict goes wrong while
 * still reading as authoritative. That is the point: a wrong verdict and a
 * right one are the same document to a human skimming it, so the checks have to
 * be mechanical.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { validate } = require('../src/validate-verdict.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIGEST = 'a'.repeat(64);

const INPUT = {
  schema: 'judgment-input/v1',
  repo: 'demo',
  evidenceDigest: DIGEST,
  attainable: 16,
  dimensions: [
    { dimension: 1, name: 'Oracle',          eliminatory: true,  ceiling: 3, bounds: { min: 0, max: 3 }, determined: null, constraints: [], mustCite: ['D1.spec-linkage'], question: 'q' },
    { dimension: 2, name: 'Sensitivity',     eliminatory: true,  ceiling: 3, bounds: { min: 0, max: 3 }, determined: null, constraints: [], mustCite: ['D2.assertless-tests'], question: 'q' },
    { dimension: 3, name: 'Determinism',     eliminatory: false, ceiling: 2, bounds: { min: 0, max: 1 }, determined: null, constraints: [{ effect: 'capped at 1' }], mustCite: ['D3.fixed-waits'], question: 'q' },
    { dimension: 4, name: 'Diagnosis',       eliminatory: false, ceiling: 3, bounds: { min: 0, max: 3 }, determined: null, constraints: [], mustCite: ['D4.failure-context'], question: 'q' },
    { dimension: 5, name: 'Rule coverage',   eliminatory: false, ceiling: 2, bounds: { min: 0, max: 2 }, determined: null, constraints: [], mustCite: ['D5.covered-rules'], question: 'q' },
    { dimension: 6, name: 'Life in CI',      eliminatory: false, ceiling: 1, bounds: { min: 1, max: 1 }, determined: 1,    constraints: [{ effect: 'determined at 1' }], mustCite: ['D6.suite-invocation'], question: null },
    { dimension: 7, name: 'Maintainability', eliminatory: false, ceiling: 2, bounds: { min: 0, max: 2 }, determined: null, constraints: [], mustCite: ['D7.selector-mix'], question: 'q' },
  ],
  items: {
    source: {
      'D2.assertless-tests': {}, 'D3.fixed-waits': {}, 'D4.failure-context': {}, 'D7.selector-mix': {},
      'D0.suite-type-signals': {
        suites: [{
          suite: '.', testDir: 'tests',
          directories: [
            { directory: 'api', key: './api', tests: 3 },
            { directory: 'legacy', key: './legacy', tests: 5 },
          ],
        }],
      },
    },
    rules: { 'D1.spec-linkage': {}, 'D5.covered-rules': {} },
    pipelines: { 'D6.suite-invocation': {}, 'D6.pipeline-present': {} },
  },
  suiteFiles: ['qa/07-automation/e2e/tests/adm/contratos.spec.ts'],
};

const REASON = 'The expected values trace to the cited rule and were checked against the specification text.';
const FILE   = 'qa/07-automation/e2e/tests/adm/contratos.spec.ts';

function level(dimension, overrides = {}) {
  const mustCite = INPUT.dimensions.find(d => d.dimension === dimension).mustCite;
  return {
    dimension,
    level: 1,
    confidence: 'medium',
    citations: [...mustCite],
    observations: [`${FILE}:44`],
    reasoning: REASON,
    ...overrides,
  };
}

/** A verdict that passes every check, as the baseline to break in each test. */
function goodVerdict(mutate = (v) => v) {
  const levels = [
    level(1), level(2), level(3), level(4), level(5),
    level(6, { level: 1 }), level(7),
  ];
  const verdict = {
    schema: 'verdict/v2',
    repo: 'demo',
    evidenceDigest: DIGEST,
    suiteType: {
      type: 'regression',
      citations: ['D0.suite-type-signals'],
      reasoning: 'No defect ids and no expected failures in any directory; expected values come from the rule catalogue.',
    },
    levels,
    obtained: levels.reduce((n, l) => n + l.level, 0),
    attainable: 16,
    eliminated: false,
    eliminatedBy: [],
    thresholdObjections: [],
    notes: '',
  };
  return mutate(verdict) ?? verdict;
}

function codes(result) {
  return result.errors.map(e => e.code);
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

test('a well formed verdict passes', (t) => {
  const result = validate(INPUT, goodVerdict());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.summary.obtained, 7);
});

// ---------------------------------------------------------------------------
// Stale evidence
// ---------------------------------------------------------------------------

test('a verdict written against different evidence is rejected, not reconciled', (t) => {
  // It describes a repository state that no longer exists. Adjusting it would
  // carry conclusions from one snapshot into another.
  const result = validate(INPUT, goodVerdict(v => { v.evidenceDigest = 'b'.repeat(64); }));

  assert.equal(result.valid, false);
  assert.deepEqual(codes(result), ['stale-digest']);
  assert.match(result.errors[0].message, /re-judge rather than adjust/);
});

test('a verdict for another repository is rejected', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.repo = 'other'; }));
  assert.ok(codes(result).includes('repo-mismatch'));
});

// ---------------------------------------------------------------------------
// Fabrication
// ---------------------------------------------------------------------------

test('a citation to an item that does not exist is caught', (t) => {
  const result = validate(INPUT, goodVerdict(v => {
    v.levels[0].citations = ['D1.spec-linkage', 'D1.oracle-quality-index'];
  }));

  assert.ok(codes(result).includes('fabricated-item'));
  assert.match(result.errors.find(e => e.code === 'fabricated-item').message, /D1\.oracle-quality-index/);
});

test('an observation pointing outside the resolved suite is caught', (t) => {
  const result = validate(INPUT, goodVerdict(v => {
    v.levels[1].observations = ['qa/07-automation/e2e/tests/does-not-exist.spec.ts:10'];
  }));

  assert.ok(codes(result).includes('fabricated-file'));
});

test('an observation that is not file:line is caught', (t) => {
  const result = validate(INPUT, goodVerdict(v => {
    v.levels[1].observations = ['somewhere in the login tests'];
  }));

  assert.ok(codes(result).includes('observation-format'));
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test('a level above the range the evidence permits is caught, with the reason', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.levels[2].level = 2; v.obtained = 8; }));

  const err = result.errors.find(e => e.code === 'out-of-bounds');
  assert.ok(err);
  assert.match(err.message, /capped at 1/, 'the reader must see which constraint was violated');
});

test('changing a level the evidence already settled is caught', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.levels[5].level = 0; v.obtained = 6; }));

  assert.ok(codes(result).includes('overrides-evidence'));
});

// ---------------------------------------------------------------------------
// Citation discipline
// ---------------------------------------------------------------------------

test('an open dimension that cites none of its required items is caught', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.levels[0].citations = ['D6.pipeline-present']; }));
  assert.ok(codes(result).includes('uncited'));
});

test('a settled dimension is not required to cite anything', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.levels[5].citations = []; }));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('a level with no argument behind it is caught', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.levels[3].reasoning = 'Good.'; }));
  assert.ok(codes(result).includes('thin-reasoning'));
});

// ---------------------------------------------------------------------------
// Arithmetic and elimination
// ---------------------------------------------------------------------------

test('a total that does not match the levels is caught', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.obtained = 14; }));
  assert.ok(codes(result).includes('bad-total'));
});

test('an attainable that does not match the evidence is caught', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.attainable = 21; }));
  assert.ok(codes(result).includes('bad-attainable'));
});

test('a zero on an eliminatory dimension must be reported as elimination', (t) => {
  // The failure mode this catches is a report that lists a 0 on Sensitivity and
  // still closes with a passing total.
  const result = validate(INPUT, goodVerdict(v => {
    v.levels[1].level = 0;
    v.obtained = 6;
  }));

  assert.ok(codes(result).includes('missed-elimination'));
});

test('elimination must name the dimensions that caused it', (t) => {
  const result = validate(INPUT, goodVerdict(v => {
    v.levels[1].level = 0;
    v.obtained = 6;
    v.eliminated = true;
    v.eliminatedBy = [1];
  }));

  assert.ok(codes(result).includes('elimination-mismatch'));
});

test('elimination cannot be claimed without a zero on an eliminatory dimension', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.eliminated = true; }));
  assert.ok(codes(result).includes('false-elimination'));
});

test('a zero on a non eliminatory dimension does not eliminate', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.levels[3].level = 0; v.obtained = 6; }));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

// ---------------------------------------------------------------------------
// The source bands must not come back
// ---------------------------------------------------------------------------

test('reusing the source rubric verdict scale is caught', (t) => {
  // Those bands assume complete evidence. Printing "15/21 - Aprueba" against a
  // 16 point ceiling tells the reader something that is not true.
  const result = validate(INPUT, goodVerdict(v => { v.notes = 'Resultado: 7/21, no aprueba todavia.'; }));
  assert.ok(codes(result).includes('source-bands'));
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

test('claiming the top level without having read anything warns', (t) => {
  const result = validate(INPUT, goodVerdict(v => {
    v.levels[0].level = 3;
    v.levels[0].observations = [];
    v.obtained = 9;
  }));

  assert.equal(result.valid, true, 'it is allowed');
  assert.ok(result.warnings.some(w => w.code === 'top-without-observation'), 'but it is flagged');
});

test('low confidence above the floor warns', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.levels[0].confidence = 'low'; }));
  assert.ok(result.warnings.some(w => w.code === 'low-confidence-not-lowest'));
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

test('a missing dimension is caught', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.levels = v.levels.slice(0, 6); v.obtained = 6; }));
  assert.ok(codes(result).includes('missing-dimension'));
});

test('a duplicated dimension is caught', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.levels.push(level(1, { level: 3 })); v.obtained = 10; }));
  assert.ok(codes(result).includes('duplicate-dimension'));
});

test('a dimension that is not in the rubric is caught', (t) => {
  const result = validate(INPUT, goodVerdict(v => { v.levels.push(level(1, { dimension: 8 })); v.obtained = 8; }));
  assert.ok(codes(result).includes('unknown-dimension'));
});

test('a level pinned by a constraint is not warned about as an unread claim', (t) => {
  // D3 in this fixture is capped at 1 by evidence. Choosing 1 is the only
  // option left, not a confident guess, and warning about it teaches the
  // reader to ignore warnings.
  const result = validate(INPUT, goodVerdict(v => { v.levels[2].observations = []; }));

  assert.equal(result.valid, true);
  assert.ok(!result.warnings.some(w => w.code === 'top-without-observation'),
    'a narrowed range is pinned, not claimed');
});

test('a level at the top of an untouched range still warns', (t) => {
  const result = validate(INPUT, goodVerdict(v => {
    v.levels[3].level = 3;          // D4 has no constraints
    v.levels[3].observations = [];
    v.obtained = 9;
  }));

  assert.ok(result.warnings.some(w => w.code === 'top-without-observation'));
});

test('a verdict may cite the risk register it read', (t) => {
  // The questions about the oracle and about coverage are answered by reading
  // specification documents, and a risk register is one of them. If it is not
  // citable, the only honest answer is one the validator rejects.
  const withRisks = {
    ...INPUT,
    items: {
      ...INPUT.items,
      rules: {
        ...INPUT.items.rules,
        'D1.risk-inventory': { present: true, register: 'qa/01-specifications/_risks.md', risks: 3, catalogue: [{ id: 'R-01', file: 'qa/01-specifications/_risks.md', line: 18 }] },
        'D5.risk-coverage': { count: 1, of: 3 },
      },
    },
  };

  const result = validate(withRisks, goodVerdict(v => {
    v.levels[4].observations = ['qa/01-specifications/_risks.md:18'];
  }));

  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

// ---------------------------------------------------------------------------
// Suite type (step 0, verdict/v2)
// ---------------------------------------------------------------------------

const SIGNALS = 'D0.suite-type-signals';
const SUITE_REASON = 'The legacy directory is full of defect ids; the api directory derives its values from the rules.';

test('a verdict/v1 verdict is rejected as predating suite type, not migrated', () => {
  const result = validate(INPUT, goodVerdict(v => { v.schema = 'verdict/v1'; delete v.suiteType; }));

  assert.equal(result.valid, false);
  const err = result.errors.find(e => e.code === 'schema');
  assert.ok(err, JSON.stringify(result.errors));
  assert.match(err.message, /predate suite type/);
  assert.match(err.message, /re-judged/);
  assert.match(err.message, /not migrated/);
});

test('an unknown schema is still a schema error', () => {
  const result = validate(INPUT, goodVerdict(v => { v.schema = 'verdict/v9'; }));
  assert.ok(codes(result).includes('schema'));
});

test('a verdict without suiteType is caught', () => {
  const result = validate(INPUT, goodVerdict(v => { delete v.suiteType; }));
  assert.deepEqual(codes(result), ['suite-type-missing']);
});

test('a suite type outside the four values is caught', () => {
  const result = validate(INPUT, goodVerdict(v => { v.suiteType.type = 'smoke'; }));
  assert.ok(codes(result).includes('suite-type-invalid'));
});

test('a suite type that does not cite the signals is caught', () => {
  const result = validate(INPUT, goodVerdict(v => { v.suiteType.citations = ['D2.assertless-tests']; }));
  assert.ok(codes(result).includes('suite-type-uncited'));
});

test('a suite type with no citations at all is caught', () => {
  const result = validate(INPUT, goodVerdict(v => { delete v.suiteType.citations; }));
  assert.ok(codes(result).includes('suite-type-uncited'));
});

test('a suite type citing an item that does not exist is a fabricated citation', () => {
  const result = validate(INPUT, goodVerdict(v => { v.suiteType.citations = [SIGNALS, 'D0.invented']; }));
  const err = result.errors.find(e => e.code === 'fabricated-item');
  assert.ok(err);
  assert.match(err.message, /D0\.invented/);
});

test('suite type reasoning keeps the same minimum as a level', () => {
  const result = validate(INPUT, goodVerdict(v => { v.suiteType.reasoning = 'Regression.'; }));
  assert.ok(codes(result).includes('thin-reasoning'));
});

test('mixed must break down every group in the signals', () => {
  const ok = validate(INPUT, goodVerdict(v => {
    v.suiteType = { type: 'mixed', byDirectory: { './api': 'regression', './legacy': 'defect-harness' }, citations: [SIGNALS], reasoning: SUITE_REASON };
  }));
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));

  const missing = validate(INPUT, goodVerdict(v => {
    v.suiteType = { type: 'mixed', byDirectory: { './api': 'regression' }, citations: [SIGNALS], reasoning: SUITE_REASON };
  }));
  assert.ok(codes(missing).includes('suite-type-mixed-breakdown'));
  assert.match(missing.errors.find(e => e.code === 'suite-type-mixed-breakdown').message, /\.\/legacy/);

  const none = validate(INPUT, goodVerdict(v => {
    v.suiteType = { type: 'mixed', citations: [SIGNALS], reasoning: SUITE_REASON };
  }));
  assert.ok(codes(none).includes('suite-type-mixed-breakdown'));
});

test('a mixed breakdown value must be one of the three non-mixed types', () => {
  for (const bad of ['mixed', 'smoke']) {
    const result = validate(INPUT, goodVerdict(v => {
      v.suiteType = { type: 'mixed', byDirectory: { './api': 'regression', './legacy': bad }, citations: [SIGNALS], reasoning: SUITE_REASON };
    }));
    assert.ok(codes(result).includes('suite-type-mixed-breakdown'), bad);
  }
});

test('a mixed breakdown may not name a group the signals do not have', () => {
  const result = validate(INPUT, goodVerdict(v => {
    v.suiteType = { type: 'mixed', byDirectory: { './api': 'regression', './legacy': 'characterization', './ghost': 'regression' }, citations: [SIGNALS], reasoning: SUITE_REASON };
  }));
  assert.ok(codes(result).includes('suite-type-mixed-breakdown'));
});

test('a non-mixed suite type must not carry a breakdown', () => {
  const result = validate(INPUT, goodVerdict(v => { v.suiteType.byDirectory = { './api': 'regression', './legacy': 'regression' }; }));
  assert.ok(codes(result).includes('suite-type-mixed-breakdown'));
});

test('the suite type moves no bound, total or elimination', () => {
  // Issue #10 is open on purpose: a ceiling the judge can raise by declaring
  // something is not a bound. The same levels must validate identically
  // whatever type is declared.
  const declare = {
    regression: { type: 'regression' },
    'defect-harness': { type: 'defect-harness' },
    characterization: { type: 'characterization' },
    mixed: { type: 'mixed', byDirectory: { './api': 'regression', './legacy': 'defect-harness' } },
  };
  const runs = Object.entries(declare).map(([name, st]) => validate(INPUT, goodVerdict(v => {
    v.suiteType = { ...st, citations: [SIGNALS], reasoning: SUITE_REASON };
  })));

  for (const r of runs) assert.equal(r.valid, true, JSON.stringify(r.errors));
  for (const r of runs.slice(1)) assert.deepEqual(r, runs[0]);

  // And a level the evidence forbids stays forbidden under every type.
  for (const [name, st] of Object.entries(declare)) {
    const r = validate(INPUT, goodVerdict(v => {
      v.suiteType = { ...st, citations: [SIGNALS], reasoning: SUITE_REASON };
      v.levels[2].level = 2; v.obtained = 8;
    }));
    assert.ok(codes(r).includes('out-of-bounds'), name);
  }
});

test('evidence without the D0 item says to regenerate it, not that the citation is fabricated', () => {
  const { 'D0.suite-type-signals': _gone, ...source } = INPUT.items.source;
  const outdated = { ...INPUT, items: { ...INPUT.items, source } };

  const result = validate(outdated, goodVerdict());
  assert.ok(codes(result).includes('evidence-outdated'), JSON.stringify(result.errors));
  assert.match(result.errors.find(e => e.code === 'evidence-outdated').message, /regenerate the evidence/);
  for (const misleading of ['fabricated-item', 'suite-type-uncited', 'suite-type-missing', 'suite-type-mixed-breakdown']) {
    assert.ok(!codes(result).includes(misleading), `${misleading} would mislead`);
  }
});

test('evidence without the D0 item is outdated even for a mixed declaration', () => {
  const { 'D0.suite-type-signals': _gone, ...source } = INPUT.items.source;
  const result = validate({ ...INPUT, items: { ...INPUT.items, source } }, goodVerdict(v => {
    v.suiteType = { type: 'mixed', byDirectory: { './api': 'regression' }, citations: [SIGNALS], reasoning: SUITE_REASON };
  }));
  assert.deepEqual(codes(result), ['evidence-outdated']);
});
