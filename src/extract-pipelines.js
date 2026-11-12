#!/usr/bin/env node
/**
 * extract-pipelines.js - CI evidence extractor
 *
 *   D6.pipeline-present   D6.pipeline-triggers   D6.suite-invocation
 *   D6.result-publication D6.declared-gating D6.run-scope
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
// D6.run-scope: how much of the suite an invocation runs
// ---------------------------------------------------------------------------
//
// D6.suite-invocation says a pipeline calls the runner; this says with what
// filters. Evidence only: nothing here is compared to a threshold, and D6 is
// still decided by D6.runs-the-suite exactly as before.
//
// LIMIT: a filter whose value is a pipeline variable ($(VAR), ${{ ... }}, $VAR)
// is kept raw and marked `variable: true`. Such a value is set per run on the
// CI server (a queue-time variable, a workflow input, a matrix cell), so the
// repository cannot say what is effectively run. The judge reads the marker;
// the extractor does not guess.

/** YAML keys whose value is a shell command. A displayName only talks about one. */
const COMMAND_KEYS = new Set(['script', 'run', 'bash', 'powershell', 'pwsh', 'cmd', 'command', 'inlinescript']);

/** `<indent>[- ]key: value`. Group 1 is the prefix, so its length is the key column. */
const YAML_KEY     = /^(\s*(?:-\s+)*)([A-Za-z_][\w.-]*)\s*:\s*(.*)$/;
const BLOCK_HEADER = /^[|>][+-]?\d*\s*(?:#.*)?$/;
const WORKING_DIR  = /^\s*(?:-\s+)?(?:working-directory|workingDirectory)\s*:\s*(.+?)\s*$/i;

/** A trailing backslash (shell) or backtick (PowerShell) continues the command. */
const CONTINUATION = /(?:\\|`)\s*$/;

/** A pipeline variable: Azure $(X), GitHub ${{ x }}, shell $X or ${X}, cmd %X%. */
const VARIABLE = /\$[({]|\$[A-Za-z_]|%[A-Za-z_]\w*%/;

/** Variables that stand for the checkout root, so a directory under them is knowable. */
const ROOT_VARIABLE = /^(?:\$\((?:Build\.SourcesDirectory|System\.DefaultWorkingDirectory|Build\.Repository\.LocalPath)\)|\$\{\{\s*github\.workspace\s*\}\}|\$\{?GITHUB_WORKSPACE\}?)[\\/]?/;

/** Commands that print their arguments instead of running them. */
const PRINTERS = new Set(['echo', 'printf', 'write-host', 'write-output']);

/** Filtering flags that take a value, as spelled in the runner, by canonical name. */
const FILTER_VALUE_FLAGS = new Map([
  ['--grep', '--grep'], ['-g', '--grep'],
  ['--grep-invert', '--grep-invert'],
  ['--project', '--project'],
  ['--shard', '--shard'],
  ['--tag', '--tag'],
  ['--config', '--config'], ['-c', '--config'],
]);

/**
 * Value-less filters. --only-changed takes its base ref only when joined with
 * `=`: a space-separated word after it cannot be told from a test path.
 */
const FILTER_SWITCHES = new Set(['--last-failed', '--only-changed']);

/**
 * Flags that tune the run and take a value in the next word. They must be
 * known so that the value is not mistaken for a positional test path; an
 * unknown flag is assumed to take none.
 */
const TUNING_VALUE_FLAGS = new Set([
  '--workers', '-j', '--reporter', '--retries', '--timeout', '--output',
  '--max-failures', '--repeat-each', '--trace', '--tsconfig', '--global-timeout',
  '--ui-host', '--ui-port',
]);

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isVariable(value) {
  return typeof value === 'string' && VARIABLE.test(value);
}

function unquoteYaml(value) {
  const m = /^(['"])(.*)\1$/.exec(value);
  return m ? m[2] : value;
}

/** Joins physical lines that end in a continuation marker into logical lines. */
function joinContinuations(entries) {
  const out = [];
  let current = null;

  for (const entry of entries) {
    const text = entry.text.trim();
    if (!current && text === '') continue;

    if (current) current.text += ' ' + text;
    else current = { line: entry.line, text };

    if (CONTINUATION.test(current.text)) {
      current.text = current.text.replace(CONTINUATION, '').trimEnd();
      continue;
    }
    out.push(current);
    current = null;
  }
  if (current) out.push(current);
  return out;
}

/** A folded (`>`) block is one command: its lines are joined by the YAML rule. */
function fold(entries) {
  const filled = entries.filter(e => e.text.trim() !== '');
  if (filled.length === 0) return [];
  return [{ line: filled[0].line, text: filled.map(e => e.text.trim()).join(' ') }];
}

/**
 * The shell commands of a pipeline as logical lines, each with the physical
 * line it starts on. Only values under command keys count, so a step named
 * "Run npx playwright test" is not an invocation.
 */
function commandLines(text) {
  const lines   = stripBom(text).split(/\r?\n/);
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const m = YAML_KEY.exec(lines[i]);
    if (!m || !COMMAND_KEYS.has(m[2].toLowerCase())) continue;

    const keyColumn = m[1].length;
    const keyIndex  = i;
    const value     = m[3].trim();
    let logical;

    if (BLOCK_HEADER.test(value)) {
      const body = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > keyColumn)) {
        body.push({ line: j + 1, text: lines[j] });
        j++;
      }
      logical = value.startsWith('>') ? fold(body) : joinContinuations(body);
      i = j - 1;
    } else if (value !== '') {
      const body = [{ line: i + 1, text: value }];
      while (CONTINUATION.test(body[body.length - 1].text) && i + 1 < lines.length) {
        body.push({ line: i + 2, text: lines[i + 1] });
        i++;
      }
      logical = joinContinuations(body).map(e => ({ ...e, text: unquoteYaml(e.text) }));
    } else {
      continue;
    }

    for (const e of logical) entries.push({ ...e, keyIndex });
  }

  return { lines, entries };
}

/** Where a `$(...)` or `${{ ... }}` expression ends (exclusive), so its spaces stay inside one word. */
function expressionEnd(s, start) {
  if (s.startsWith('${{', start)) {
    const close = s.indexOf('}}', start + 3);
    return close === -1 ? s.length : close + 2;
  }
  let depth = 0;
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i + 1;
  }
  return s.length;
}

/** The end (exclusive) of a redirection such as `> out.txt` or `2>&1`, whose target is not an argument. */
function redirectEnd(s, start) {
  let i = start + 1;
  while (s[i] === '>' || s[i] === '<') i++;
  if (s[i] === '&') i++;
  while (s[i] === ' ' || s[i] === '\t') i++;
  while (i < s.length && !/[\s;|&]/.test(s[i])) i++;
  return i;
}

/**
 * Splits one logical line into commands made of words, the way a shell would
 * for the cases that matter here: quotes group, `&&` `||` `;` `|` end a
 * command, an unquoted `#` starts a comment, redirections are dropped, and
 * variable expressions stay whole.
 */
function splitCommands(s) {
  const commands = [];
  let current = [];
  let word = '';
  let inWord = false;

  const endWord = () => { if (inWord) current.push(word); word = ''; inWord = false; };
  const endCommand = () => { endWord(); if (current.length) commands.push(current); current = []; };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (c === '"' || c === "'") {
      const close = s.indexOf(c, i + 1);
      const end = close === -1 ? s.length : close;
      word += s.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '$' && (s[i + 1] === '(' || s.startsWith('{{', i + 1))) {
      const end = expressionEnd(s, i);
      word += s.slice(i, end);
      inWord = true;
      i = end - 1;
    } else if (/\s/.test(c)) {
      endWord();
    } else if (c === '#' && !inWord) {
      break;
    } else if (c === '&' || c === '|' || c === ';') {
      endCommand();
      if (c !== ';' && s[i + 1] === c) i++;
    } else if (c === '>' || c === '<') {
      if (/^\d$/.test(word)) { word = ''; inWord = false; } else endWord();
      i = redirectEnd(s, i) - 1;
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

function dropEnvAssignments(words) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++;
  return words.slice(i);
}

/** Arguments after `playwright test`, or null when the command is not a runner call. */
function runnerArgs(words) {
  const at = words.findIndex((w, k) => /(?:^|[\\/])playwright$/.test(w) && words[k + 1] === 'test');
  return at === -1 ? null : words.slice(at + 2);
}

/**
 * Filters and positional paths in the runner's arguments. Playwright's other
 * flags tune the run (workers, reporter, retries, headed, trace) and do not
 * narrow it, so they are skipped.
 */
function parseRunnerArgs(args) {
  const filters = [];
  const paths   = [];

  for (let k = 0; k < args.length; k++) {
    const word = args[k];

    if (word === '--') { paths.push(...args.slice(k + 1)); break; }

    if (word.startsWith('-') && word.length > 1) {
      const eq     = word.indexOf('=');
      const name   = eq === -1 ? word : word.slice(0, eq);
      const inline = eq === -1 ? null : word.slice(eq + 1);

      if (FILTER_VALUE_FLAGS.has(name)) {
        const flag  = FILTER_VALUE_FLAGS.get(name);
        const value = inline ?? args[++k] ?? '';
        const entry = { flag, value };
        // --config picks which config to read; it does not narrow what runs.
        if (flag === '--config') entry.filtering = false;
        if (isVariable(value)) entry.variable = true;
        filters.push(entry);
      } else if (FILTER_SWITCHES.has(name)) {
        const entry = { flag: name, value: inline };
        if (isVariable(inline)) entry.variable = true;
        filters.push(entry);
      } else if (inline === null && TUNING_VALUE_FLAGS.has(name)) {
        k++;
      }
      continue;
    }

    paths.push(word);
  }

  return { filters, paths };
}

/** One package script followed one level, never recursively. */
function packageScriptInvocations(words, scripts) {
  const [manager, ...rest] = words;
  let name;
  let extra = [];

  if (manager === 'npm') {
    if (rest[0] === 'test' || rest[0] === 't') { name = 'test'; extra = rest.slice(1); }
    else if (rest[0] === 'run' || rest[0] === 'run-script') { name = rest[1]; extra = rest.slice(2); }
  } else if (manager === 'yarn' || manager === 'pnpm') {
    const k = rest[0] === 'run' ? 1 : 0;
    name = rest[k];
    extra = rest.slice(k + 1);
  }

  if (!name || name.startsWith('-') || typeof scripts?.[name] !== 'string') return [];

  // npm forwards only what follows `--`; yarn and pnpm forward the rest as given.
  const dashes = extra.indexOf('--');
  const forwarded = manager === 'npm'
    ? (dashes === -1 ? [] : extra.slice(dashes + 1))
    : (dashes === -1 ? extra : [...extra.slice(0, dashes), ...extra.slice(dashes + 1)]);

  const commands = splitCommands(scripts[name]);
  const found = [];
  commands.forEach((command, idx) => {
    const args = runnerArgs(dropEnvAssignments(command));
    if (!args) return;
    // The forwarded arguments land at the end of the script string.
    const last = idx === commands.length - 1;
    found.push({ args: last ? [...args, ...forwarded] : args, via: 'package-script', script: name });
  });
  return found;
}

/**
 * The working directory declared by the step that owns line `keyIndex`, or
 * null. A step runs from its `- ` item to the next line at or above that
 * item's indentation.
 */
function stepWorkingDirectory(lines, keyIndex) {
  const prefix = YAML_KEY.exec(lines[keyIndex])[1];
  let start = -1;
  let itemIndent = -1;

  if (prefix.includes('-')) {
    start = keyIndex;
    itemIndent = prefix.indexOf('-');
  } else {
    for (let k = keyIndex - 1; k >= 0; k--) {
      if (lines[k].trim() === '') continue;
      const dash = /^(\s*)-\s/.exec(lines[k]);
      if (dash && dash[1].length < prefix.length) { start = k; itemIndent = dash[1].length; break; }
      if (!dash && indentOf(lines[k]) < prefix.length) break;
    }
  }
  if (start === -1) return null;

  for (let k = start; k < lines.length; k++) {
    if (k > start && lines[k].trim() !== '' && indentOf(lines[k]) <= itemIndent) break;
    const m = WORKING_DIR.exec(lines[k]);
    if (m) return unquoteYaml(m[1]);
  }
  return null;
}

/** A directory the repository can know: variables other than the checkout root make it unknowable. */
function literalDir(value) {
  if (value == null) return null;
  const dir = value.replace(ROOT_VARIABLE, '');
  return isVariable(dir) ? null : dir;
}

/** `rel` from `from`, clamped to the repository so a stray `..` cannot read outside it. */
function resolveDir(root, from, rel) {
  const target = path.resolve(from, rel);
  const within = path.relative(root, target);
  return within.startsWith('..') || path.isAbsolute(within) ? root : target;
}

/** `scripts` of the package.json nearest `dir`, walking up to the repository root. */
function nearestPackageScripts(root, dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const file = path.join(d, 'package.json');
    if (fs.existsSync(file)) {
      try { return JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))).scripts ?? {}; }
      catch { return {}; }
    }
    if (d === root || path.dirname(d) === d) return {};
  }
}

function describeInvocation({ args, via, script }, line, raw) {
  const { filters, paths } = parseRunnerArgs(args);
  const narrowing = filters.filter(f => f.filtering !== false);

  const invocation = {
    line,
    raw,
    scope: narrowing.length > 0 || paths.length > 0 ? 'filtered' : 'full',
    filters,
    paths,
  };
  if (via) { invocation.via = via; invocation.script = script; }
  if (narrowing.some(f => f.variable) || paths.some(isVariable)) invocation.variable = true;
  return invocation;
}

/** Every runner invocation in one pipeline file, direct or one package script away. */
function runInvocations(repoRoot, file) {
  const root = path.resolve(repoRoot);
  const { lines, entries } = commandLines(fs.readFileSync(file, 'utf8'));
  const scriptCache = new Map();
  const scriptsAt = (dir) => {
    if (!scriptCache.has(dir)) scriptCache.set(dir, nearestPackageScripts(root, dir));
    return scriptCache.get(dir);
  };

  const invocations = [];
  for (const entry of entries) {
    let cwd = resolveDir(root, root, literalDir(stepWorkingDirectory(lines, entry.keyIndex)) ?? '');

    for (const raw of splitCommands(entry.text)) {
      const words = dropEnvAssignments(raw);
      if (words.length === 0 || PRINTERS.has(words[0].toLowerCase())) continue;

      if (words[0] === 'cd') {
        const dir = literalDir(words[1]);
        if (dir !== null) cwd = resolveDir(root, cwd, dir);
        continue;
      }

      const direct = runnerArgs(words);
      const found  = direct ? [{ args: direct }] : packageScriptInvocations(words, scriptsAt(cwd));
      for (const f of found) invocations.push(describeInvocation(f, entry.line, entry.text));
    }
  }
  return invocations;
}

function summarizeRunScope(repoRoot, running) {
  const pipelines = running
    .map(p => ({ file: p.file, invocations: runInvocations(repoRoot, path.join(repoRoot, p.file)) }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  return {
    pipelines,
    // A pipeline with no recognisable invocation is in neither count: it is
    // not known to be filtered, and it is not known to be full.
    filteredPipelines: pipelines.filter(p => p.invocations.length > 0 && p.invocations.every(i => i.scope === 'filtered')).length,
    fullPipelines: pipelines.filter(p => p.invocations.some(i => i.scope === 'full')).length,
    note: 'scope is read from the pipeline text; a filter marked variable is set outside the repository and its effective scope is unknowable here',
  };
}

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
      'D6.run-scope': summarizeRunScope(repoRoot, running),
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
