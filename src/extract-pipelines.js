#!/usr/bin/env node
/**
 * extract-pipelines.js - CI evidence extractor
 *
 *   D6.pipeline-present   D6.pipeline-triggers   D6.suite-invocation
 *   D6.result-publication D6.declared-gating
 *
 * Ceiling: 1. Levels 2 and 3 of the rubric ("blocks the merge", "green is a
 * condition for deploying") are enforcement facts held by the CI server, not by
 * the repository. A pipeline that declares a pull request trigger states an
 * intention; whether the merge is actually blocked lives in a branch policy
 * this extractor cannot read. Reporting intention as enforcement is precisely
 * the error the ceiling exists to prevent, so level 2 and 3 are declared
 * unreachable rather than guessed.
 *
 * Identification by content, not by location
 * ------------------------------------------
 * Four different directories of junk YAML turned up while building this:
 * .playwright-mcp and .playwright-cli page snapshots, _scratch-legacy dumps,
 * execution-artifact snapshots, and application i18n resources. One repository
 * holds 1801 YAML files of which six are pipelines. A blacklist of directory
 * names would need extending for every new repository, so a file counts as a
 * pipeline when its own top level declares pipeline keys.
 *
 * Usage:
 *   node extract-pipelines.js <repoPath> [--json] [--out <file>]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { resolveSuite } = require('./resolve-suite.js');

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

/** Keys that only a pipeline definition declares at its top level. */
const STRONG_KEYS = new Set(['trigger', 'on', 'stages', 'schedules', 'extends']);
const WEAK_KEYS   = new Set(['jobs', 'steps', 'pool', 'pr', 'resources', 'parameters', 'variables']);

const PRUNED_DIRS = new Set([
  '.git', '.claude', 'node_modules', 'dist', 'build', 'out', 'bin', 'obj',
  'coverage', 'test-results', 'playwright-report', '.auth', '.vs', '.vscode', '.idea',
]);

/** Run steps that execute a Playwright suite. */
const SUITE_RUN = /\b(npx\s+playwright\s+test|playwright\s+test|npm\s+(run\s+)?test)\b/g;

/** Steps that make results visible after the run. */
const PUBLISH_RESULTS  = /PublishTestResults@\d|actions\/upload-artifact@|PublishPipelineArtifact@\d|PublishBuildArtifacts@\d/g;
const PUBLISH_TO_PLANS = /ADO_[A-Z_]*PLAN_ID|playwright-azure-reporter|SYSTEM_ACCESSTOKEN/g;

// ---------------------------------------------------------------------------
// Minimal YAML surface reader
// ---------------------------------------------------------------------------

/**
 * Top-level keys and the raw block belonging to each.
 *
 * Only the document surface is read: enough to answer which triggers exist and
 * what the steps run, without taking a YAML dependency or pretending to
 * understand templates, anchors and expressions.
 */
function topLevelBlocks(text) {
  const lines = stripBom(text).split(/\r?\n/);
  const blocks = new Map();

  let current = null;
  let buffer  = [];

  for (const line of lines) {
    const key = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);

    if (key) {
      if (current) blocks.set(current, buffer.join('\n'));
      current = key[1];
      buffer  = [key[2]];
      continue;
    }

    if (current !== null) buffer.push(line);
  }

  if (current) blocks.set(current, buffer.join('\n'));
  return blocks;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Whether a trigger key is declared AND enabled.
 *
 * Azure Pipelines spells "no automatic trigger" as `pr: none` and
 * `trigger: none`. Treating the key's presence as a declaration reports a
 * pipeline that explicitly disables pull request runs as one that gates on
 * them - overstating exactly the evidence D6 is capped for.
 */
function declared(blocks, key) {
  if (!blocks.has(key)) return false;
  const value = (blocks.get(key) ?? '').trim();
  return value.toLowerCase() !== 'none';
}

/**
 * Whether the text points at a suite directory, exactly or through an ancestor
 * of at least two segments. One pipeline sets a variable to 'qa/07-automation'
 * and runs the suite living at 'qa/07-automation/e2e'.
 */
function referencesPath(text, suiteId) {
  if (text.includes(suiteId)) return true;

  const parts = suiteId.split('/');
  for (let n = parts.length - 1; n >= 2; n--) {
    if (text.includes(parts.slice(0, n).join('/'))) return true;
  }
  return false;
}

function isPipeline(blocks) {
  const keys = [...blocks.keys()];
  const strong = keys.filter(k => STRONG_KEYS.has(k)).length;
  const weak   = keys.filter(k => WEAK_KEYS.has(k)).length;
  return strong >= 1 || weak >= 2;
}

function flavor(blocks) {
  if (blocks.has('on') && blocks.has('jobs')) return 'github-actions';
  return 'azure-pipelines';
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

function walkYaml(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!PRUNED_DIRS.has(entry.name)) walkYaml(full, out);
    } else if (/\.ya?ml$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function rel(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function count(text, re) {
  re.lastIndex = 0;
  return (text.match(re) ?? []).length;
}

// ---------------------------------------------------------------------------
// Per-pipeline analysis
// ---------------------------------------------------------------------------

function analyze(repoRoot, file, suiteIds) {
  const text   = stripBom(fs.readFileSync(file, 'utf8'));
  const blocks = topLevelBlocks(text);

  const on = blocks.get('on') ?? '';

  const triggers = {
    push:        declared(blocks, 'trigger') || /\bpush\s*:/.test(on),
    pullRequest: declared(blocks, 'pr')      || /\bpull_request\s*:/.test(on),
    schedule:    declared(blocks, 'schedules') || /\bschedule\s*:/.test(on),
    manual:      /workflow_dispatch/.test(on) || blocks.has('parameters'),
  };

  // A pipeline can only be said to run THIS suite if a run step invokes the
  // runner and the pipeline points at the suite. A suite rooted at the
  // repository root is invoked by running the runner at all; a nested suite
  // must be named, either exactly or by an ancestor directory such as
  // qa/07-automation for a suite at qa/07-automation/e2e.
  const runSteps = count(text, SUITE_RUN);
  const suitePaths = runSteps > 0
    ? suiteIds.filter(id => id === '.' || referencesPath(text, id))
    : [];

  return {
    file: rel(repoRoot, file),
    flavor: flavor(blocks),
    triggers,
    runSteps,
    referencedSuites: suitePaths.sort(),
    publishesResults: count(text, PUBLISH_RESULTS) > 0,
    publishesToTestPlans: count(text, PUBLISH_TO_PLANS) > 0,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function extractPipelines(repoRoot) {
  const boundary = resolveSuite(repoRoot);
  const suiteIds = boundary.suites.map(s => s.id);

  const candidates = walkYaml(repoRoot);
  const pipelines  = [];

  for (const file of candidates) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!isPipeline(topLevelBlocks(text))) continue;
    pipelines.push(analyze(repoRoot, file, suiteIds));
  }

  const running = pipelines.filter(p => p.runSteps > 0 && p.referencedSuites.length > 0);

  return {
    schema: 'pipeline-evidence/v1',
    repo: boundary.repo,
    ceiling: {
      dimension: 'D6',
      attainable: 1,
      reason: 'levels 2 and 3 assert merge and deploy gating, which lives in the CI server policy',
    },
    items: {
      'D6.pipeline-present': {
        yamlScanned: candidates.length,
        pipelinesIdentified: pipelines.length,
        files: pipelines.map(p => p.file).sort(),
      },
      'D6.suite-invocation': {
        pipelinesRunningTheSuite: running.length,
        note: 'a pipeline counts only when it invokes the runner AND names a resolved suite directory',
        files: running.map(p => p.file).sort(),
      },
      'D6.pipeline-triggers': summarizeTriggers(running.length ? running : pipelines),
      'D6.result-publication': {
        publishingResults: pipelines.filter(p => p.publishesResults).length,
        publishingToTestPlans: pipelines.filter(p => p.publishesToTestPlans).length,
      },
      'D6.declared-gating': {
        pipelinesDeclaringPrTrigger: pipelines.filter(p => p.triggers.pullRequest).length,
        evidenceClass: 'declaration',
        note: 'a pull request trigger is an intention; enforcement lives in the branch policy and is out of scope for v1',
      },
    },
    pipelines,
  };
}

function summarizeTriggers(pipelines) {
  const any = (key) => pipelines.filter(p => p.triggers[key]).length;
  return {
    push: any('push'),
    pullRequest: any('pullRequest'),
    schedule: any('schedule'),
    manual: any('manual'),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printHuman(r) {
  const i = r.items;
  console.log(`Repo: ${r.repo}`);
  console.log(`D6 ceiling: ${r.ceiling.attainable} - ${r.ceiling.reason}`);
  console.log('');
  console.log(`  D6.pipeline-present    ${i['D6.pipeline-present'].pipelinesIdentified} pipeline(s) from ${i['D6.pipeline-present'].yamlScanned} yaml file(s)`);
  for (const f of i['D6.pipeline-present'].files) console.log(`      ${f}`);
  console.log(`  D6.suite-invocation    ${i['D6.suite-invocation'].pipelinesRunningTheSuite} run the resolved suite`);
  const t = i['D6.pipeline-triggers'];
  console.log(`  D6.pipeline-triggers   push=${t.push} pr=${t.pullRequest} schedule=${t.schedule} manual=${t.manual}`);
  console.log(`  D6.result-publication  results=${i['D6.result-publication'].publishingResults} testPlans=${i['D6.result-publication'].publishingToTestPlans}`);
  console.log(`  D6.declared-gating     ${i['D6.declared-gating'].pipelinesDeclaringPrTrigger} declare a pr trigger (declaration, not enforcement)`);
}

function main() {
  const args = process.argv.slice(2);
  const repoArg = args.find(a => !a.startsWith('--'));

  if (!repoArg) {
    console.error('Usage: node extract-pipelines.js <repoPath> [--json] [--out <file>]');
    process.exit(2);
  }

  const result = extractPipelines(path.resolve(repoArg));
  const json   = JSON.stringify(result, null, 2);

  const outIdx = args.indexOf('--out');
  if (outIdx !== -1 && args[outIdx + 1]) {
    const target = path.resolve(args[outIdx + 1]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, json + '\n', 'utf8');
  }

  if (args.includes('--json')) console.log(json);
  else printHuman(result);
}

if (require.main === module) main();

module.exports = { extractPipelines, topLevelBlocks, isPipeline, flavor, analyze };
