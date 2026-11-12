/**
 * judge-prep.test.js - Tests for the judgment bounding step.
 *
 * This is where the instrument stops being deterministic, so these tests guard
 * the seam: that thresholds are declared rather than hidden, that a bound the
 * evidence settles is never handed to an agent, and that a level nobody can
 * witness is never offered as reachable.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const { prepare, DIMENSIONS, THRESHOLDS } = require('../src/judge-prep.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(t, tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-prep-'));
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

const PIPELINE = [
  'trigger:',
  '  branches:',
  '    include:',
  '      - master',
  'pool:',
  "  vmImage: 'ubuntu-latest'",
  'steps:',
  '  - script: npx playwright test',
  "    workingDirectory: 'tests'",
].join('\n');

/** Build a spec file of `total` tests, `assertless` of which have no check. */
function specFile(total, assertless, extra = '') {
  const lines = ["import { test, expect } from '@playwright/test';"];
  for (let i = 1; i <= total; i++) {
    const id = `TC-CON-${String(i).padStart(3, '0')}`;
    const body = i <= assertless
      ? `await page.goto('/');`
      : `await expect(page.locator('#total')).toHaveText('42');`;
    lines.push(`test('[${id}] case ${i}', async ({ page }) => { ${body} ${extra} });`);
  }
  return lines.join('\n');
}

function dim(result, n) {
  return result.dimensions.find(d => d.dimension === n);
}

const FULL_REPO = (spec, pipeline = PIPELINE) => ({
  'playwright.config.ts': CONFIG,
  'tests/con.spec.ts': spec,
  [`${SPEC_BASE}/01-business-rules.md`]: RULES_MD,
  [`${SPEC_BASE}/05-test-scenarios.md`]: SCENARIOS_MD,
  'qa/pipelines/ci.yml': pipeline,
});

// ---------------------------------------------------------------------------
// Thresholds are declared, not hidden
// ---------------------------------------------------------------------------

test('every threshold records what it interprets and what it costs to disagree', (t) => {
  assert.ok(THRESHOLDS.thresholds.length > 0);

  for (const th of THRESHOLDS.thresholds) {
    assert.ok(th.id, 'threshold needs an id');
    assert.ok(th.rubricText, `${th.id} must quote the rubric text it interprets`);
    assert.ok(['literal', 'calibration'].includes(th.kind), `${th.id} must say whether it is a reading or a choice`);
    assert.ok(th.rationale && th.rationale.length > 40, `${th.id} needs a rationale someone can argue with`);
    assert.ok(th.disagreementCost, `${th.id} must state what moving it costs`);
  }
});

test('the source verdict bands are explicitly not applied', (t) => {
  // They were calibrated for complete evidence. v1 reads only the repository.
  assert.equal(THRESHOLDS.verdictBands.applySourceBands, false);
});

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

test('v1 is attainable at 16, not 21', (t) => {
  const total = DIMENSIONS.reduce((n, d) => n + d.ceiling, 0);
  assert.equal(total, 16);
});

test('a repository with a rule inventory keeps the 16 point ceiling', (t) => {
  const root = makeRepo(t, FULL_REPO(specFile(10, 0)));
  assert.equal(prepare(root).attainable, 16);
});

test('a repository with no rule inventory drops to 13', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': CONFIG,
    'tests/con.spec.ts': specFile(10, 0),
    'qa/pipelines/ci.yml': PIPELINE,
  });

  const r = prepare(root);
  assert.equal(r.attainable, 13);
  assert.equal(dim(r, 1).ceiling, 1);
  assert.equal(dim(r, 5).ceiling, 1);
});

test('every dimension states why its ceiling is where it is', (t) => {
  const root = makeRepo(t, FULL_REPO(specFile(10, 0)));
  for (const d of prepare(root).dimensions) {
    assert.ok(d.ceilingReason && d.ceilingReason.length > 10, `D${d.dimension} needs a ceiling reason`);
  }
});

// ---------------------------------------------------------------------------
// Caps from evidence
// ---------------------------------------------------------------------------

const WITH_MUTATION = (spec) => ({
  ...FULL_REPO(spec),
  'stryker.conf.json': '{}',
});

test('an isolated assertless test does not cap sensitivity', (t) => {
  // 1 in 100 is a finding to fix, not a characteristic of the suite. The test
  // is still reported individually by file and line. Mutation config is present
  // so that the separate level 3 cap does not mask what this test is about.
  const root = makeRepo(t, WITH_MUTATION(specFile(100, 1)));
  const r = prepare(root);

  assert.equal(dim(r, 2).bounds.max, 3, 'sensitivity stays open');
  assert.equal(r.items.source['D2.assertless-tests'].count, 1, 'but the test is still named');
});

test('no mutation config caps sensitivity at 2, as a calibration', (t) => {
  const root = makeRepo(t, FULL_REPO(specFile(100, 1)));
  const r = prepare(root);
  const d2 = dim(r, 2);

  assert.equal(r.items.source['D2.mutation-config'].count, 0);
  assert.equal(d2.bounds.max, 2);
  assert.equal(d2.determined, null, 'the cap never settles the dimension');
  assert.equal(d2.bounds.min, 0, 'and it is never floored');
  assert.equal(d2.ceiling, 3, 'the structural ceiling is unchanged; the cap is evidence-driven');

  const c = d2.constraints.find(x => x.threshold === 'D2.sensitivity-measured');
  assert.ok(c, 'the constraint must show in the report');
  assert.equal(c.kind, 'calibration', 'the rubric level is a disjunction, so this is a choice');
});

test('mutation config lifts the cap but does not floor or settle level 3', (t) => {
  const root = makeRepo(t, WITH_MUTATION(specFile(100, 0)));
  const r = prepare(root);
  const d2 = dim(r, 2);

  assert.equal(r.items.source['D2.mutation-config'].count, 1);
  assert.equal(d2.bounds.max, 3);
  assert.equal(d2.bounds.min, 0);
  assert.equal(d2.determined, null, 'config present does not prove mutation testing is running');
  assert.ok(!d2.constraints.some(x => x.threshold === 'D2.sensitivity-measured'));
  assert.ok(d2.question, 'level 3 is still argued by the judge');
});

test('the systemic assertless cap at 0 wins over the mutation cap', (t) => {
  const root = makeRepo(t, FULL_REPO(specFile(100, 10)));
  const d2 = dim(prepare(root), 2);

  assert.equal(d2.determined, 0);
  assert.equal(d2.bounds.max, 0);
  assert.ok(d2.constraints.some(x => x.threshold === 'D2.systemic-assertless'));
  assert.ok(d2.constraints.some(x => x.threshold === 'D2.sensitivity-measured'),
    'both applied; the lower cap decides');
});

test('a decoy mutation config in node_modules does not lift the cap', (t) => {
  const root = makeRepo(t, { ...FULL_REPO(specFile(10, 0)), 'node_modules/dep/stryker.conf.json': '{}' });
  assert.equal(dim(prepare(root), 2).bounds.max, 2);
});

test('D2 answers must be able to cite the mutation evidence', (t) => {
  const root = makeRepo(t, FULL_REPO(specFile(10, 0)));
  assert.ok(dim(prepare(root), 2).mustCite.includes('D2.mutation-config'));
});

test('systemically assertless tests cap sensitivity at zero', (t) => {
  const root = makeRepo(t, FULL_REPO(specFile(100, 10)));
  const d2 = dim(prepare(root), 2);

  assert.equal(d2.determined, 0);
  assert.equal(d2.eliminatory, true);
  assert.equal(d2.constraints[0].kind, 'calibration',
    'the reader must see that a choice, not the rubric, drew this line');
});

test('waiting as the synchronization strategy caps determinism', (t) => {
  const root = makeRepo(t, FULL_REPO(specFile(10, 0, 'await page.waitForTimeout(1000); await page.waitForTimeout(500);')));
  assert.equal(dim(prepare(root), 3).bounds.max, 1);
});

test('occasional fixed waits do not cap determinism', (t) => {
  const spec = specFile(10, 0).replace(
    "test('[TC-CON-001] case 1', async ({ page }) => {",
    "test('[TC-CON-001] case 1', async ({ page }) => { await page.waitForTimeout(500);"
  );
  const root = makeRepo(t, FULL_REPO(spec));
  assert.equal(dim(prepare(root), 3).bounds.max, 2);
});

test('no failure artifact caps diagnosis at level 1', (t) => {
  const bare = CONFIG.replace("  use: { trace: 'retain-on-failure' },", '');
  const root = makeRepo(t, { ...FULL_REPO(specFile(10, 0)), 'playwright.config.ts': bare });
  assert.equal(dim(prepare(root), 4).bounds.max, 1);
});

// ---------------------------------------------------------------------------
// The one floor
// ---------------------------------------------------------------------------

test('a pipeline that runs the suite determines CI at level 1', (t) => {
  const root = makeRepo(t, FULL_REPO(specFile(10, 0)));
  const d6 = dim(prepare(root), 6);

  assert.equal(d6.determined, 1);
  assert.equal(d6.question, null, 'a settled dimension is never asked about');
});

test('no pipeline running the suite determines CI at level 0', (t) => {
  const tree = FULL_REPO(specFile(10, 0));
  delete tree['qa/pipelines/ci.yml'];
  const root = makeRepo(t, tree);

  assert.equal(dim(prepare(root), 6).determined, 0);
});

/** A pipeline whose only run step is `run`, in a repo with the given package.json scripts. */
function ciRunning(run, scripts) {
  const pipeline = ['trigger:', '  branches:', '    include:', '      - master',
    'steps:', `  - script: ${run}`].join('\n');
  const tree = FULL_REPO(specFile(10, 0), pipeline);
  if (scripts) tree['package.json'] = JSON.stringify({ scripts });
  return tree;
}

test('a suite run through `npm run e2e` determines CI at level 1', (t) => {
  // D6 is settled by evidence, so a missed invocation is a settled, wrong 0.
  const root = makeRepo(t, ciRunning('npm run e2e', { e2e: 'playwright test' }));
  assert.equal(dim(prepare(root), 6).determined, 1);
});

test('yarn and pnpm script invocations determine CI at level 1', (t) => {
  for (const run of ['yarn e2e', 'yarn run e2e', 'pnpm e2e', 'pnpm run e2e']) {
    const root = makeRepo(t, ciRunning(run, { e2e: 'npx playwright test --project=chromium' }));
    assert.equal(dim(prepare(root), 6).determined, 1, run);
  }
});

test('yarn test and pnpm test resolve through the test script', (t) => {
  for (const run of ['yarn test', 'pnpm test']) {
    const root = makeRepo(t, ciRunning(run, { test: 'playwright test' }));
    assert.equal(dim(prepare(root), 6).determined, 1, run);
  }
});

test('a gitlab script list that runs the suite determines CI at level 1', (t) => {
  const yaml = ['stages: [test]', 'e2e:', '  stage: test', '  script:', '    - cd e2e', '    - npx playwright test'].join('\n');
  const root = makeRepo(t, {
    'e2e/playwright.config.ts': CONFIG,
    'e2e/tests/con.spec.ts': specFile(10, 0),
    '.gitlab-ci.yml': yaml,
  });
  assert.equal(dim(prepare(root), 6).determined, 1);
});

test('a gitlab before_script that runs the suite determines CI at level 1', (t) => {
  const yaml = ['stages: [test]', 'e2e:', '  stage: test', '  before_script:', '    - npx playwright test', '  script:', '    - echo done'].join('\n');
  const root = makeRepo(t, {
    'e2e/playwright.config.ts': CONFIG,
    'e2e/tests/con.spec.ts': specFile(10, 0),
    '.gitlab-ci.yml': yaml,
  });
  assert.equal(dim(prepare(root), 6).determined, 1);
});

test('a script that resolves to another runner does not run the suite: CI is 0', (t) => {
  for (const run of ['npm run e2e', 'npm test', 'yarn test', 'pnpm run e2e']) {
    const root = makeRepo(t, ciRunning(run, { e2e: 'jest', test: 'vitest run' }));
    assert.equal(dim(prepare(root), 6).determined, 0, run);
  }
});

test('npm test with no package.json to resolve keeps counting, as it always did', (t) => {
  const root = makeRepo(t, ciRunning('npm test'));
  assert.equal(dim(prepare(root), 6).determined, 1);
});

test('an unresolvable yarn or pnpm script is not counted', (t) => {
  // Only the legacy npm test forms keep the benefit of the doubt.
  for (const run of ['yarn e2e', 'pnpm test']) {
    const root = makeRepo(t, ciRunning(run));
    assert.equal(dim(prepare(root), 6).determined, 0, run);
  }
});

// ---------------------------------------------------------------------------
// The judgment surface
// ---------------------------------------------------------------------------

test('an open dimension carries a question and the items its answer must cite', (t) => {
  const root = makeRepo(t, FULL_REPO(specFile(10, 0)));

  for (const d of prepare(root).dimensions) {
    if (d.determined !== null) {
      assert.equal(d.question, null, `D${d.dimension} is settled and must not be asked`);
      continue;
    }
    assert.ok(d.question && d.question.length > 30, `D${d.dimension} needs an answerable question`);
    assert.ok(d.mustCite.length > 0, `D${d.dimension} must name the items its answer cites`);
  }
});

test('every citable item named by a dimension exists in the evidence', (t) => {
  // A typo here would let a level cite an item that does not exist, and the
  // citation requirement would quietly stop meaning anything.
  const root = makeRepo(t, FULL_REPO(specFile(10, 0)));
  const r = prepare(root);
  const available = new Set([
    ...Object.keys(r.items.source),
    ...Object.keys(r.items.rules),
    ...Object.keys(r.items.pipelines),
  ]);

  for (const d of r.dimensions) {
    for (const item of d.mustCite) {
      assert.ok(available.has(item), `D${d.dimension} cites unknown item ${item}`);
    }
  }
});

test('bounds never exceed the dimension ceiling', (t) => {
  const root = makeRepo(t, FULL_REPO(specFile(10, 0)));
  for (const d of prepare(root).dimensions) {
    assert.ok(d.bounds.max <= d.ceiling, `D${d.dimension} offers a level above its ceiling`);
    assert.ok(d.bounds.min <= d.bounds.max, `D${d.dimension} has inverted bounds`);
  }
});

// ---------------------------------------------------------------------------
// Binding the verdict to the evidence
// ---------------------------------------------------------------------------

test('the same repository yields the same digest', (t) => {
  const root = makeRepo(t, FULL_REPO(specFile(10, 0)));
  assert.equal(prepare(root).evidenceDigest, prepare(root).evidenceDigest);
});

test('changing the suite changes the digest', (t) => {
  // A verdict is bound to a digest. If the evidence moves, the verdict is stale
  // rather than silently reused.
  const a = makeRepo(t, FULL_REPO(specFile(10, 0)));
  const b = makeRepo(t, FULL_REPO(specFile(11, 0)));
  assert.notEqual(prepare(a).evidenceDigest, prepare(b).evidenceDigest);
});

test('the preparation assigns no level it was not forced to', (t) => {
  const root = makeRepo(t, FULL_REPO(specFile(10, 0)));
  const r = prepare(root);

  const settled = r.dimensions.filter(d => d.determined !== null);
  for (const d of settled) {
    assert.ok(d.constraints.length > 0, `D${d.dimension} was settled without stating why`);
  }
});

test('a suite that queries nothing is not capped for selector fragility', (t) => {
  // Absent evidence is not bad evidence. A suite with zero selectors of any
  // kind has no selector mix, and a share computed from zero must not decide
  // a level. Found against two repositories whose whole suite is one API test.
  const apiOnly = [
    "import { test, expect } from '@playwright/test';",
    "test('[TC-API-001] health returns 200', async ({ request }) => {",
    "  const response = await request.get('/health');",
    '  expect(response.status()).toBe(200);',
    '});',
  ].join('\n');

  const root = makeRepo(t, FULL_REPO(apiOnly));
  const r = prepare(root);

  assert.equal(r.items.source['D7.selector-mix'].semanticShare, null, 'no selectors were observed');
  assert.equal(dim(r, 7).bounds.max, 2, 'so maintainability stays open');
});
