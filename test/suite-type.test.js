/**
 * suite-type.test.js - D0.suite-type-signals: signals only, never a type.
 *
 * Step 0 of docs/JUDGMENT-PROTOCOL.md asks what kind of suite this is before any
 * level is scored. The scripts must not answer that: a classification the
 * script makes is a judgment the validator can no longer check, and a type that
 * moved a bound would be a bound the judge could raise by declaring something
 * (issue #10). So these tests pin the signals, and pin the absence of a verdict.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const { prepare }     = require('../src/judge-prep.js');
const { extractFile } = require('../src/extract-source.js');

const ITEM = 'D0.suite-type-signals';

// The module under test is required lazily so that a missing implementation
// fails each test on its own assertion rather than on one import at load time.
const suiteType = () => require('../src/suite-type.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(t, tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-type-'));
  for (const [rel, contents] of Object.entries(tree)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, 'utf8');
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const CONFIG = [
  "import { defineConfig } from '@playwright/test';",
  'export default defineConfig({',
  "  testDir: './tests',",
  "  use: { trace: 'retain-on-failure' },",
  '});',
].join('\n');

const SPEC_BASE = 'qa/01-specifications/module-ADM/submodule-CON';

const RULES_MD = [
  '# Reglas',
  '## RN-ADM-CON-001 -- Acceso',
  'Texto.',
  '## RN-ADM-CON-002 -- Cuenta',
  'Texto.',
].join('\n');

const SCENARIOS_MD = [
  '# Escenarios',
  '| ID | Titulo | Notas |',
  '|---|---|---|',
  '| TC-CON-001 | Acceso | RN-ADM-CON-001 |',
  '| TC-CON-002 | Cuenta | RN-ADM-CON-002 |',
].join('\n');

const HEAD = "import { test, expect } from '@playwright/test';";
const CHECK = "await expect(page.locator('#a')).toHaveText('1');";

/** Six defect-titled tests, one parked with test.fail, in a nested directory. */
const DEFECTS_SPEC = [
  HEAD,
  ...[1, 2, 3, 4, 5, 6].map(i => `test('DEF-10${i} total is wrong', async ({ page }) => { ${CHECK} });`),
  `test.fail('[TC-CON-002] BUG-7 pinned', async ({ page }) => { ${CHECK} });`,
].join('\n');

const FIXTURE = {
  'playwright.config.ts': CONFIG,
  // Directly in the test root: groups as '.'.
  'tests/root.spec.ts': [HEAD, `test('[TC-CON-001] access', async ({ page }) => { ${CHECK} });`].join('\n'),
  'tests/legacy/defects.spec.ts': DEFECTS_SPEC,
  // A defect id carried by the FILE NAME, not by any title.
  'tests/legacy/bug_77.spec.ts': [HEAD, `test('renders', async ({ page }) => { ${CHECK} });`].join('\n'),
  'tests/visual/shots.spec.ts': [
    HEAD,
    "test('[TC-CON-099] home looks right', async ({ page }) => { await expect(page).toHaveScreenshot(); });",
    "test('table', async ({ page }) => { await expect(await page.content()).toMatchSnapshot('t.txt'); expect(1).toMatchInlineSnapshot('1'); });",
  ].join('\n'),
  [`${SPEC_BASE}/01-business-rules.md`]: RULES_MD,
  [`${SPEC_BASE}/05-test-scenarios.md`]: SCENARIOS_MD,
};

function item(t, tree = FIXTURE) {
  return prepare(makeRepo(t, tree)).items.source[ITEM];
}

function directory(it, suite, name) {
  return it.suites.find(s => s.suite === suite).directories.find(d => d.directory === name);
}

function keysDeep(value, out = []) {
  if (Array.isArray(value)) value.forEach(v => keysDeep(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); keysDeep(v, out); }
  }
  return out;
}

function recordsFor(t, source) {
  const root = makeRepo(t, { 'playwright.config.ts': CONFIG, 'tests/a.spec.ts': source });
  return extractFile(root, 'tests/a.spec.ts');
}

// ---------------------------------------------------------------------------
// Defect id vocabulary
// ---------------------------------------------------------------------------

test('the defect id pattern lives in one exported constant and reads the documented shapes', () => {
  const { DEFECT_ID } = suiteType();

  for (const hit of [
    'DEF-12', 'bug_7', 'BUG-0042', 'ISSUE-ABC-123', 'hotfix-9', 'INC_2', 'DEFECT-A1-77', 'x DEF-1 y',
    // An underscore is a word character to \b, but it is a separator in file names.
    'checkout_bug-42.spec.ts', 'BUG-42_login.spec.ts', 'x_DEF-1_y', '[BUG-9] title',
  ]) {
    assert.ok(DEFECT_ID.test(hit), `${hit} should read as a defect id`);
  }
  for (const miss of [
    'default value', 'debug 12', 'DEF-', 'BUG-abc', 'INCOME-5', 'website-12', 'TC-CON-001',
    'debug-42', 'rebug-42', 'debug_42.spec.ts', 'BUG-42x', 'xBUG-42',
  ]) {
    assert.ok(!DEFECT_ID.test(miss), `${miss} must not read as a defect id`);
  }
});

// ---------------------------------------------------------------------------
// Per-test snapshot assertions
// ---------------------------------------------------------------------------

test('a test records how many snapshot assertions its body makes', (t) => {
  const [two, none] = recordsFor(t, [
    HEAD,
    "test('shots', async ({ page }) => {",
    "  await expect(page).toHaveScreenshot();",
    "  expect(await page.content()).toMatchSnapshot('a.txt');",
    "  expect(1).toMatchInlineSnapshot('1');",
    "  await expect(page.locator('#a')).toMatchAriaSnapshot('- button');",
    '});',
    `test('plain', async ({ page }) => { ${CHECK} });`,
  ].join('\n'));

  assert.equal(two.snapshotAssertions, 4);
  assert.equal(none.snapshotAssertions, 0);
});

test('a snapshot call named inside a string or a comment is not an assertion', (t) => {
  const [r] = recordsFor(t, [
    HEAD,
    "test('prose', async ({ page }) => {",
    "  // toMatchSnapshot( would be the next step",
    "  console.log('toHaveScreenshot( is mentioned here');",
    `  ${CHECK}`,
    '});',
  ].join('\n'));

  assert.equal(r.snapshotAssertions, 0);
});

// ---------------------------------------------------------------------------
// The item
// ---------------------------------------------------------------------------

test('the signals are emitted under items.source and join the digest', (t) => {
  const root = makeRepo(t, FIXTURE);
  const a = prepare(root);
  assert.ok(a.items.source[ITEM], `${ITEM} must be emitted under items.source`);

  const renamed = makeRepo(t, {
    ...FIXTURE,
    'tests/legacy/defects.spec.ts': DEFECTS_SPEC.replace('DEF-101', 'plain-101'),
  });
  assert.notEqual(prepare(renamed).evidenceDigest, a.evidenceDigest,
    'a changed signal is different evidence, so it must move the digest');
});

test('signals are grouped per suite and per top-level test directory', (t) => {
  const it = item(t);

  assert.deepEqual(it.suites.map(s => s.suite), ['.']);
  assert.equal(it.suites[0].testDir, 'tests');
  assert.deepEqual(it.suites[0].directories.map(d => d.directory).sort(), ['.', 'legacy', 'visual']);
  assert.equal(directory(it, '.', '.').tests, 1, 'files directly in the test root group as "."');
  assert.equal(directory(it, '.', 'legacy').tests, 8);
  assert.equal(directory(it, '.', 'visual').tests, 2);
});

test('each group carries the key a verdict must use for it', (t) => {
  const it = item(t);
  const { groupKeys } = suiteType();

  assert.deepEqual(groupKeys(it), ['./.', './legacy', './visual']);
  assert.equal(directory(it, '.', 'legacy').key, './legacy');
});

test('defect ids are counted from titles and file names, with at most five examples', (t) => {
  const legacy = directory(item(t), '.', 'legacy');

  // six DEF titles + the BUG-7 title + the bug_77 file name
  assert.equal(legacy.defectIds.count, 8);
  assert.equal(legacy.defectIds.examples.length, 5);
  assert.ok(legacy.defectIds.examples.every(e => /^tests\/legacy\/[^:]+:\d+$/.test(e)), 'file:line references');
  assert.deepEqual(legacy.defectIds.examples, [...legacy.defectIds.examples].sort(), 'deterministic order');

  assert.equal(directory(item(t), '.', '.').defectIds.count, 0);
  assert.deepEqual(directory(item(t), '.', 'visual').defectIds.examples, []);
});

test('expected failures reuse the per-test test.fail reading', (t) => {
  const it = item(t);
  assert.equal(directory(it, '.', 'legacy').expectedFailures.count, 1);
  assert.equal(directory(it, '.', 'visual').expectedFailures.count, 0);
});

test('snapshot assertions are counted in tests that make at least one', (t) => {
  const it = item(t);
  assert.equal(directory(it, '.', 'visual').snapshotAssertions.count, 2);
  assert.equal(directory(it, '.', 'legacy').snapshotAssertions.count, 0);
});

test('case ids are split into those the rule join links to a declared rule and the rest', (t) => {
  const it = item(t);

  // TC-CON-001 and TC-CON-002 are declared and linked; TC-CON-099 is in no scenario document.
  assert.deepEqual(directory(it, '.', '.').caseIds, { count: 1 });
  assert.deepEqual(directory(it, '.', '.').caseIdsLinkedToRules, { count: 1 });
  assert.equal(directory(it, '.', 'legacy').caseIdsLinkedToRules.count, 1);
  assert.equal(directory(it, '.', 'visual').caseIds.count, 1);
  assert.equal(directory(it, '.', 'visual').caseIdsLinkedToRules.count, 0);
});

test('without a rule inventory no case id is linked to a rule', (t) => {
  const { [`${SPEC_BASE}/01-business-rules.md`]: _a, [`${SPEC_BASE}/05-test-scenarios.md`]: _b, ...bare } = FIXTURE;
  const it = item(t, bare);

  assert.equal(directory(it, '.', 'legacy').caseIds.count, 1);
  assert.equal(directory(it, '.', 'legacy').caseIdsLinkedToRules.count, 0);
});

test('every suite is reported on its own', (t) => {
  const tree = {
    'a/playwright.config.ts': CONFIG,
    'a/tests/e2e/x.spec.ts': [HEAD, `test('DEF-1 one', async ({ page }) => { ${CHECK} });`].join('\n'),
    'b/playwright.config.ts': CONFIG,
    'b/tests/y.spec.ts': [HEAD, `test('two', async ({ page }) => { ${CHECK} });`].join('\n'),
  };
  const it = item(t, tree);
  const { groupKeys } = suiteType();

  assert.deepEqual(it.suites.map(s => s.suite), ['a', 'b']);
  assert.equal(directory(it, 'a', 'e2e').defectIds.count, 1);
  assert.equal(directory(it, 'b', '.').defectIds.count, 0);
  assert.deepEqual(groupKeys(it), ['a/e2e', 'b/.']);
});

// ---------------------------------------------------------------------------
// Signals only
// ---------------------------------------------------------------------------

test('the evidence never carries a classification', (t) => {
  // The judge classifies; the validator checks the classification is declared
  // and cited. A script that wrote one would leave nothing to check.
  const forbidden = ['suiteType', 'type', 'classification', 'level', 'score', 'verdict', 'rating'];
  const keys = new Set(keysDeep(item(t)));

  for (const k of forbidden) assert.ok(!keys.has(k), `${ITEM} must not carry a "${k}" key`);
});

test('the signals move no bound: the same structure with and without them bounds the same', (t) => {
  // Issue #10 is open on purpose. Whatever D0 reports, no ceiling, cap or floor
  // may read it.
  const { 'tests/legacy/bug_77.spec.ts': bugFile, ...rest } = FIXTURE;
  const plain = {
    ...rest,
    'tests/legacy/defects.spec.ts': DEFECTS_SPEC.replace(/DEF-10/g, 'plain-10').replace('BUG-7', 'plain 7'),
    'tests/legacy/renders.spec.ts': bugFile,
    'tests/visual/shots.spec.ts': FIXTURE['tests/visual/shots.spec.ts']
      .replace('toHaveScreenshot()', "toHaveText('1')")
      .replace("toMatchSnapshot('t.txt')", "toBe('x')")
      .replace("toMatchInlineSnapshot('1')", 'toBe(1)'),
  };

  const a = prepare(makeRepo(t, FIXTURE));
  const b = prepare(makeRepo(t, plain));

  assert.notDeepEqual(a.items.source[ITEM], b.items.source[ITEM], 'the fixtures must differ in the signals');
  assert.deepEqual(a.dimensions, b.dimensions);
  assert.equal(a.attainable, b.attainable);
  assert.equal(a.maxPossibleGivenEvidence, b.maxPossibleGivenEvidence);
});

test('boundDimensions is identical without D0, with it, and with an extreme D0', (t) => {
  // The direct guard for issue #10: the bounding function itself must not read
  // the item, whatever it says.
  const { boundDimensions } = require('../src/judge-prep.js');
  const { extractEvidence } = require('../src/extract-source.js');
  const { extractPipelines } = require('../src/extract-pipelines.js');

  const root = makeRepo(t, FIXTURE);
  const full = prepare(root);
  const { extractMutationConfig } = require('../src/extract-mutation.js');
  const extracted = extractEvidence(root);
  // Mutation tooling joins the source items in prepare(); boundDimensions reads it.
  const source = { ...extracted, items: { ...extracted.items, ...extractMutationConfig(root) } };
  const pipes = extractPipelines(root);
  assert.ok(!(ITEM in source.items), 'the extractor alone must not emit D0');

  const withItem = (d0) => ({ ...source, items: { ...source.items, [ITEM]: d0 } });
  const extreme = {
    suites: [{ suite: '.', testDir: 'tests', directories: [{
      directory: 'legacy', key: './legacy', tests: 1e9,
      defectIds: { count: 1e9, examples: [] }, expectedFailures: { count: 1e9 },
      snapshotAssertions: { count: 1e9 }, caseIds: { count: 0 }, caseIdsLinkedToRules: { count: 0 },
    }] }],
  };

  const base = boundDimensions(source, full.items.rules, pipes);
  assert.deepEqual(boundDimensions(withItem(full.items.source[ITEM]), full.items.rules, pipes), base);
  assert.deepEqual(boundDimensions(withItem(extreme), full.items.rules, pipes), base);
  assert.deepEqual(boundDimensions(withItem({ suites: [] }), full.items.rules, pipes), base);
});
