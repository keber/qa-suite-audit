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
