/**
 * extract-pipelines.test.js - Tests for the CI evidence extractor.
 *
 * D6 is capped at level 1 because enforcement lives in the CI server. That cap
 * only means something if the extractor never reports an intention as a fact,
 * so the trigger tests below are the ones that matter most here.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const {
  extractPipelines,
  topLevelBlocks,
  isPipeline,
  flavor,
} = require('../src/extract-pipelines.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(t, tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-evidence-'));
  for (const [rel, contents] of Object.entries(tree)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, 'utf8');
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const PW_CONFIG = [
  "import { defineConfig } from '@playwright/test';",
  "export default defineConfig({ testDir: './tests' });",
].join('\n');

const SPEC = "import { test, expect } from '@playwright/test';\ntest('[TC-A-001] a', async ({ page }) => { await expect(page).toHaveTitle('x'); });\n";

/** A page snapshot dumped by tooling: YAML, but not a pipeline. */
const SNAPSHOT = [
  '- Page URL: https://example.com/login',
  '- Page Title: Login',
  '- Page Snapshot:',
  '    - textbox "Email"',
  '    - button "Sign in"',
].join('\n');

function azurePipeline({ pr = 'none', trigger = true, schedule = false, run = 'npx playwright test', suitePath = 'qa/07-automation/e2e' } = {}) {
  const lines = [];
  if (trigger) lines.push('trigger:', '  branches:', '    include:', '      - master');
  lines.push(`pr: ${pr}`);
  if (schedule) lines.push('schedules:', "  - cron: '10 12 * * 1-5'", '    always: true');
  lines.push(
    'pool:',
    "  vmImage: 'ubuntu-latest'",
    'steps:',
    '  - script: |',
    `      ${run}`,
    `    workingDirectory: '${suitePath}'`,
    '  - task: PublishTestResults@2',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Identification by content
// ---------------------------------------------------------------------------

test('a tooling page snapshot is not identified as a pipeline', (t) => {
  // One repository holds 1801 yaml files of which six are pipelines. A
  // directory blacklist would need a new entry for every tool that dumps YAML.
  assert.equal(isPipeline(topLevelBlocks(SNAPSHOT)), false);
});

test('an i18n resource file is not identified as a pipeline', (t) => {
  const resource = ['greeting: Hello', 'farewell: Goodbye', 'errors:', '  notFound: Not found'].join('\n');
  assert.equal(isPipeline(topLevelBlocks(resource)), false);
});

test('an azure pipeline and a github workflow are both identified', (t) => {
  assert.equal(isPipeline(topLevelBlocks(azurePipeline())), true);
  assert.equal(flavor(topLevelBlocks(azurePipeline())), 'azure-pipelines');

  const workflow = ['name: CI', 'on:', '  push:', '    branches: [main]', 'jobs:', '  build:', '    runs-on: ubuntu-latest'].join('\n');
  assert.equal(isPipeline(topLevelBlocks(workflow)), true);
  assert.equal(flavor(topLevelBlocks(workflow)), 'github-actions');
});

test('a leading byte order mark does not hide the first key', (t) => {
  const withBom = '﻿' + azurePipeline();
  assert.equal(isPipeline(topLevelBlocks(withBom)), true);
});

// ---------------------------------------------------------------------------
// Triggers: declaration versus disablement
// ---------------------------------------------------------------------------

test('pr: none is not a pull request trigger', (t) => {
  // Five real pipelines spell it exactly this way. Reading the key's presence
  // as a declaration reports a pipeline that DISABLES pull request runs as one
  // that gates on them, inflating the very evidence D6 is capped for.
  const root = makeRepo(t, {
    'playwright.config.ts': PW_CONFIG,
    'tests/a.spec.ts': SPEC,
    'qa/pipelines/ci.yml': azurePipeline({ pr: 'none' }),
  });

  const items = extractPipelines(root).items;
  assert.equal(items['D6.pipeline-triggers'].pullRequest, 0);
  assert.equal(items['D6.declared-gating'].pipelinesDeclaringPrTrigger, 0);
});

test('an enabled pr block is a declaration, and is labelled as one', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': PW_CONFIG,
    'tests/a.spec.ts': SPEC,
    'qa/pipelines/ci.yml': azurePipeline({ pr: '\n  branches:\n    include:\n      - master' }),
  });

  const gating = extractPipelines(root).items['D6.declared-gating'];
  assert.equal(gating.pipelinesDeclaringPrTrigger, 1);
  assert.equal(gating.evidenceClass, 'declaration',
    'a trigger states intent; enforcement lives in the branch policy');
});

test('trigger: none is not a push trigger', (t) => {
  const yaml = ['trigger: none', 'pr: none', 'pool:', "  vmImage: 'ubuntu-latest'", 'steps:', '  - script: echo hi'].join('\n');
  const root = makeRepo(t, {
    'playwright.config.ts': PW_CONFIG,
    'tests/a.spec.ts': SPEC,
    'qa/pipelines/ci.yml': yaml,
  });

  assert.equal(extractPipelines(root).items['D6.pipeline-triggers'].push, 0);
});

// ---------------------------------------------------------------------------
// Suite invocation
// ---------------------------------------------------------------------------

test('a pipeline that names the suite directory counts as running it', (t) => {
  const root = makeRepo(t, {
    'qa/07-automation/e2e/playwright.config.ts': PW_CONFIG,
    'qa/07-automation/e2e/tests/a.spec.ts': SPEC,
    'qa/pipelines/ci.yml': azurePipeline({ suitePath: 'qa/07-automation/e2e' }),
  });

  const items = extractPipelines(root).items;
  assert.equal(items['D6.suite-invocation'].pipelinesRunningTheSuite, 1);
});

test('an ancestor directory reference still counts', (t) => {
  // One pipeline sets a variable to 'qa/07-automation' and runs the suite that
  // lives at 'qa/07-automation/e2e'.
  const root = makeRepo(t, {
    'qa/07-automation/e2e/playwright.config.ts': PW_CONFIG,
    'qa/07-automation/e2e/tests/a.spec.ts': SPEC,
    'qa/pipelines/ci.yml': azurePipeline({ suitePath: 'qa/07-automation' }),
  });

  assert.equal(extractPipelines(root).items['D6.suite-invocation'].pipelinesRunningTheSuite, 1);
});

test('a suite rooted at the repository root is invoked by running the runner', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': PW_CONFIG,
    'tests/a.spec.ts': SPEC,
    'qa/pipelines/ci.yml': azurePipeline({ suitePath: '$(Build.SourcesDirectory)' }),
  });

  assert.equal(extractPipelines(root).items['D6.suite-invocation'].pipelinesRunningTheSuite, 1);
});

test('a pipeline that never invokes the runner does not run the suite', (t) => {
  const yaml = [
    'trigger:', '  branches:', '    include:', '      - master',
    'pool:', "  vmImage: 'ubuntu-latest'",
    'steps:', '  - script: echo "sync wiki only"',
  ].join('\n');

  const root = makeRepo(t, {
    'qa/07-automation/e2e/playwright.config.ts': PW_CONFIG,
    'qa/07-automation/e2e/tests/a.spec.ts': SPEC,
    'qa/pipelines/wiki.yml': yaml,
  });

  const items = extractPipelines(root).items;
  assert.equal(items['D6.pipeline-present'].pipelinesIdentified, 1);
  assert.equal(items['D6.suite-invocation'].pipelinesRunningTheSuite, 0,
    'being a pipeline is not the same as running the suite');
});

// ---------------------------------------------------------------------------
// Ceiling and contract
// ---------------------------------------------------------------------------

test('D6 declares its ceiling of 1 with a reason', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': PW_CONFIG,
    'tests/a.spec.ts': SPEC,
    'qa/pipelines/ci.yml': azurePipeline(),
  });

  const r = extractPipelines(root);
  assert.equal(r.ceiling.attainable, 1);
  assert.match(r.ceiling.reason, /policy/);
});

test('a repository with no yaml at all reports zero, not an error', (t) => {
  const root = makeRepo(t, { 'playwright.config.ts': PW_CONFIG, 'tests/a.spec.ts': SPEC });
  const items = extractPipelines(root).items;

  assert.equal(items['D6.pipeline-present'].yamlScanned, 0);
  assert.equal(items['D6.pipeline-present'].pipelinesIdentified, 0);
});

test('two runs produce identical output and no score', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': PW_CONFIG,
    'tests/a.spec.ts': SPEC,
    'qa/pipelines/ci.yml': azurePipeline(),
    'qa/snapshots/page.yml': SNAPSHOT,
  });

  const first  = JSON.stringify(extractPipelines(root), null, 2);
  const second = JSON.stringify(extractPipelines(root), null, 2);
  assert.equal(first, second);

  for (const forbidden of ['"level"', '"score"', '"verdict"', '"rating"']) {
    assert.ok(!first.includes(forbidden), `evidence must not contain ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// D6.run-scope: how much of the suite a pipeline actually runs
// ---------------------------------------------------------------------------

function ghWorkflow(steps) {
  return [
    'name: CI', 'on:', '  push:', '    branches: [main]',
    'jobs:', '  e2e:', '    runs-on: ubuntu-latest', '    steps:',
    ...steps,
  ].join('\n');
}

function azureSteps(steps) {
  return ['trigger:', '  branches:', '    include:', '      - master', 'pr: none', 'steps:', ...steps].join('\n');
}

/** Repo whose suite sits at the root, so any run step references it. */
function scopeOf(t, tree) {
  const root = makeRepo(t, { 'playwright.config.ts': PW_CONFIG, 'tests/a.spec.ts': SPEC, ...tree });
  return extractPipelines(root).items['D6.run-scope'];
}

function lineOf(yaml, needle) {
  return yaml.split('\n').findIndex(l => l.includes(needle)) + 1;
}

test('a --grep filter in a github workflow is recorded with its raw line and is not full', (t) => {
  const yaml = ghWorkflow(['      - uses: actions/checkout@v4', '      - run: npx playwright test --grep @smoke']);
  const scope = scopeOf(t, { '.github/workflows/ci.yml': yaml });

  assert.equal(scope.pipelines.length, 1);
  assert.equal(scope.pipelines[0].file, '.github/workflows/ci.yml');
  assert.deepEqual(scope.pipelines[0].invocations, [{
    line: lineOf(yaml, 'npx playwright'),
    raw: 'npx playwright test --grep @smoke',
    scope: 'filtered',
    filters: [{ flag: '--grep', value: '@smoke' }],
    paths: [],
  }]);
  assert.equal(scope.filteredPipelines, 1);
  assert.equal(scope.fullPipelines, 0);
});

test('a bare runner invocation is full', (t) => {
  const scope = scopeOf(t, { 'ci.yml': ghWorkflow(['      - run: npx playwright test']) });
  const inv = scope.pipelines[0].invocations[0];

  assert.equal(inv.scope, 'full');
  assert.deepEqual(inv.filters, []);
  assert.deepEqual(inv.paths, []);
  assert.equal(scope.fullPipelines, 1);
  assert.equal(scope.filteredPipelines, 0);
});

test('--shard=1/4 inside a multi-line script block with continuations is read as one command', (t) => {
  const yaml = azureSteps([
    '  - script: |',
    '      npm ci',
    '      npx playwright test \\',
    '        --shard=1/4 \\',
    '        --reporter=html',
    "    workingDirectory: '.'",
  ]);
  const inv = scopeOf(t, { 'qa/pipelines/ci.yml': yaml }).pipelines[0].invocations[0];

  assert.equal(inv.line, lineOf(yaml, 'npx playwright'), 'the line is where the command starts');
  assert.equal(inv.raw, 'npx playwright test --shard=1/4 --reporter=html');
  assert.equal(inv.scope, 'filtered');
  assert.deepEqual(inv.filters, [{ flag: '--shard', value: '1/4' }]);
});

test('a powershell backtick continuation joins the lines', (t) => {
  const yaml = azureSteps([
    '  - pwsh: |',
    '      npx playwright test `',
    '        --project chromium `',
    '        --workers=2',
  ]);
  const inv = scopeOf(t, { 'qa/pipelines/ci.yml': yaml }).pipelines[0].invocations[0];

  assert.equal(inv.raw, 'npx playwright test --project chromium --workers=2');
  assert.deepEqual(inv.filters, [{ flag: '--project', value: 'chromium' }]);
});

test('a folded script block is one command', (t) => {
  const yaml = azureSteps([
    '  - script: >',
    '      npx playwright test',
    '      --grep-invert @slow',
  ]);
  const inv = scopeOf(t, { 'qa/pipelines/ci.yml': yaml }).pipelines[0].invocations[0];

  assert.equal(inv.raw, 'npx playwright test --grep-invert @slow');
  assert.deepEqual(inv.filters, [{ flag: '--grep-invert', value: '@slow' }]);
});

test('positional file and directory arguments are filters', (t) => {
  const scope = scopeOf(t, {
    'ci.yml': ghWorkflow(['      - run: npx playwright test tests/smoke tests/a.spec.ts --workers=2']),
  });
  const inv = scope.pipelines[0].invocations[0];

  assert.equal(inv.scope, 'filtered');
  assert.deepEqual(inv.paths, ['tests/smoke', 'tests/a.spec.ts']);
  assert.deepEqual(inv.filters, [], '--workers is not a filter and its value is not a path');
});

test('every filtering flag spelling is recognised, quoted or equals-joined', (t) => {
  const run = [
    "npx playwright test -g 'a b' --grep=@x --project=chromium --last-failed --only-changed=origin/main --grep-invert=\"@slow\"",
  ];
  const inv = scopeOf(t, { 'ci.yml': ghWorkflow([`      - run: ${run}`]) }).pipelines[0].invocations[0];

  assert.deepEqual(inv.filters, [
    { flag: '--grep', value: 'a b' },
    { flag: '--grep', value: '@x' },
    { flag: '--project', value: 'chromium' },
    { flag: '--last-failed', value: null },
    { flag: '--only-changed', value: 'origin/main' },
    { flag: '--grep-invert', value: '@slow' },
  ]);
  assert.equal(inv.scope, 'filtered');
});

test('flags that only tune the run leave the scope full', (t) => {
  const run = 'npx playwright test --reporter=html --workers 2 --retries=1 --headed --trace on';
  const inv = scopeOf(t, { 'ci.yml': ghWorkflow([`      - run: ${run}`]) }).pipelines[0].invocations[0];

  assert.equal(inv.scope, 'full');
  assert.deepEqual(inv.filters, []);
  assert.deepEqual(inv.paths, []);
});

test('--config is recorded but is not by itself a filter', (t) => {
  const inv = scopeOf(t, {
    'ci.yml': ghWorkflow(['      - run: npx playwright test -c qa/pw.config.ts']),
  }).pipelines[0].invocations[0];

  assert.deepEqual(inv.filters, [{ flag: '--config', value: 'qa/pw.config.ts', filtering: false }]);
  assert.equal(inv.scope, 'full');
});

test('pipeline variables in a filter are kept raw and marked variable', (t) => {
  // The effective scope depends on a value the repository does not hold: it can
  // be set per run in the CI server. The evidence says so rather than guess.
  const yaml = ghWorkflow([
    '      - run: npx playwright test --grep "$(GREP_TAG)" --project=${{ matrix.project }} --shard $SHARD',
  ]);
  const inv = scopeOf(t, { 'ci.yml': yaml }).pipelines[0].invocations[0];

  assert.deepEqual(inv.filters, [
    { flag: '--grep', value: '$(GREP_TAG)', variable: true },
    { flag: '--project', value: '${{ matrix.project }}', variable: true },
    { flag: '--shard', value: '$SHARD', variable: true },
  ]);
  assert.equal(inv.variable, true);
  assert.equal(inv.scope, 'filtered');
});

test('a literal filter carries no variable marker', (t) => {
  const inv = scopeOf(t, { 'ci.yml': ghWorkflow(['      - run: npx playwright test --grep @smoke']) }).pipelines[0].invocations[0];
  assert.equal('variable' in inv, false);
  assert.equal('variable' in inv.filters[0], false);
});

test('an npm script is followed one level and the scope says it came through the script', (t) => {
  const pkg = JSON.stringify({ scripts: { 'test:smoke': 'playwright test --grep @smoke --reporter=line' } });
  const yaml = azureSteps(['  - script: npm run test:smoke']);
  const inv = scopeOf(t, { 'package.json': pkg, 'qa/pipelines/ci.yml': yaml }).pipelines[0].invocations[0];

  assert.equal(inv.raw, 'npm run test:smoke', 'raw stays the pipeline line');
  assert.equal(inv.scope, 'filtered');
  assert.deepEqual(inv.filters, [{ flag: '--grep', value: '@smoke' }]);
  assert.equal(inv.via, 'package-script');
  assert.equal(inv.script, 'test:smoke');
});

test('npm test, yarn and pnpm resolve through the package scripts too', (t) => {
  const pkg = JSON.stringify({ scripts: { test: 'playwright test', ci: 'npx playwright test tests/a.spec.ts' } });
  const yaml = azureSteps([
    '  - script: npm test',
    '  - script: yarn ci',
    '  - script: pnpm run ci',
  ]);
  const { invocations } = scopeOf(t, { 'package.json': pkg, 'qa/pipelines/ci.yml': yaml }).pipelines[0];

  assert.deepEqual(invocations.map(i => [i.script, i.scope]), [['test', 'full'], ['ci', 'filtered'], ['ci', 'filtered']]);
});

test('arguments after -- are appended to the script scope', (t) => {
  const pkg = JSON.stringify({ scripts: { 'test:e2e': 'playwright test --workers=2' } });
  const inv = scopeOf(t, {
    'package.json': pkg,
    'ci.yml': ghWorkflow(['      - run: npm run test:e2e -- --grep @smoke']),
  }).pipelines[0].invocations[0];

  assert.deepEqual(inv.filters, [{ flag: '--grep', value: '@smoke' }]);
});

test('a script that calls another script is not followed past one level', (t) => {
  const pkg = JSON.stringify({ scripts: { 'test:e2e': 'npm run inner', inner: 'playwright test --grep @x' } });
  const { pipelines } = scopeOf(t, { 'package.json': pkg, 'ci.yml': ghWorkflow(['      - run: npm run test:e2e']) });

  assert.deepEqual(pipelines[0].invocations, []);
});

test('a script that does not run the playwright runner records nothing', (t) => {
  const pkg = JSON.stringify({ scripts: { test: 'jest' } });
  const { pipelines } = scopeOf(t, { 'package.json': pkg, 'ci.yml': ghWorkflow(['      - run: npm test']) });

  assert.deepEqual(pipelines[0].invocations, []);
});

test('the package.json nearest the working directory wins over the root one', (t) => {
  const root = JSON.stringify({ scripts: { 'test:e2e': 'playwright test' } });
  const near = JSON.stringify({ scripts: { 'test:e2e': 'playwright test --project=chromium' } });
  const yaml = azureSteps([
    '  - script: npm run test:e2e',
    "    workingDirectory: 'qa/07-automation/e2e'",
  ]);
  const inv = scopeOf(t, {
    'package.json': root,
    'qa/07-automation/e2e/package.json': near,
    'qa/pipelines/ci.yml': yaml,
  }).pipelines[0].invocations[0];

  assert.deepEqual(inv.filters, [{ flag: '--project', value: 'chromium' }]);
});

test('a cd in the command moves the package lookup', (t) => {
  const near = JSON.stringify({ scripts: { 'test:e2e': 'playwright test tests/a.spec.ts' } });
  const inv = scopeOf(t, {
    'web/package.json': near,
    'ci.yml': ghWorkflow(['      - run: cd web && npm run test:e2e']),
  }).pipelines[0].invocations[0];

  assert.deepEqual(inv.paths, ['tests/a.spec.ts']);
});

test('a command inside quotes or a display name is not an invocation', (t) => {
  const yaml = azureSteps([
    '  - script: echo "npx playwright test --grep @x"',
    '    displayName: Run npx playwright test --grep @y',
    '  - script: npx playwright test # --grep @z',
  ]);
  const { invocations } = scopeOf(t, { 'qa/pipelines/ci.yml': yaml }).pipelines[0];

  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].scope, 'full');
});

test('chained commands each produce their own invocation', (t) => {
  const yaml = ghWorkflow(['      - run: npx playwright test --project=a && npx playwright test --project=b']);
  const { invocations } = scopeOf(t, { 'ci.yml': yaml }).pipelines[0];

  assert.deepEqual(invocations.map(i => i.filters[0].value), ['a', 'b']);
});

test('counts: filtered means every invocation is filtered, full means at least one is full', (t) => {
  const scope = scopeOf(t, {
    'a.yml': ghWorkflow(['      - run: npx playwright test --grep @smoke']),
    'b.yml': ghWorkflow(['      - run: npx playwright test --grep @smoke', '      - run: npx playwright test']),
    'c.yml': ghWorkflow(['      - run: npx playwright test --project=x', '      - run: npx playwright test tests/a.spec.ts']),
  });

  assert.deepEqual(scope.pipelines.map(p => p.file), ['a.yml', 'b.yml', 'c.yml']);
  assert.equal(scope.filteredPipelines, 2);
  assert.equal(scope.fullPipelines, 1);
});

test('run-scope covers exactly the pipelines D6.suite-invocation counts', (t) => {
  const items = extractPipelines(makeRepo(t, {
    'playwright.config.ts': PW_CONFIG,
    'tests/a.spec.ts': SPEC,
    'run.yml': ghWorkflow(['      - run: npx playwright test --grep @smoke']),
    'wiki.yml': ghWorkflow(['      - run: echo "sync wiki only"']),
  })).items;

  assert.deepEqual(items['D6.run-scope'].pipelines.map(p => p.file), items['D6.suite-invocation'].files);
  assert.equal(items['D6.suite-invocation'].pipelinesRunningTheSuite, 1);
});

test('run-scope is empty, not absent, when nothing runs the suite', (t) => {
  const scope = scopeOf(t, {});

  assert.deepEqual(scope.pipelines, []);
  assert.equal(scope.filteredPipelines, 0);
  assert.equal(scope.fullPipelines, 0);
});

test('run-scope evidence contains no judgment keys', (t) => {
  const scope = scopeOf(t, { 'ci.yml': ghWorkflow(['      - run: npx playwright test --grep @smoke']) });
  const json = JSON.stringify(scope);

  for (const forbidden of ['"level"', '"score"', '"verdict"', '"rating"']) {
    assert.ok(!json.includes(forbidden), `evidence must not contain ${forbidden}`);
  }
});
