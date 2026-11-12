#!/usr/bin/env node
/**
 * resolve-suite.js - Suite boundary resolver (evidence producer)
 *
 * Answers exactly one question for any repository: which files ARE the test
 * suite, which are NOT, and by which rule was each decision made. Every other
 * rubric metric depends on this boundary being right, so this step produces
 * evidence only - it never scores anything.
 *
 * Scope (v1): repository evidence only. No CI API, no run history.
 *
 * Ground truth is the runner config (testDir / testMatch / testIgnore), not a
 * filename heuristic. When no config is found the resolver falls back to
 * heuristics and downgrades its own confidence so the caller can see it.
 *
 * Output is designed to be diffed across runs: paths are repo-relative with
 * forward slashes, every list is sorted, and no timestamps are emitted.
 *
 * Usage:
 *   node resolve-suite.js <repoPath> [--json] [--out <file>]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Directories pruned during the walk, always, before any config is consulted.
 * These hold third-party code, build output, run artifacts or agent scratch
 * copies - never a repository's own suite. Pruning at walk time is what keeps
 * vendored suites (playwright-azure-reporter ships ~200 of its own tests) and
 * agent worktrees (one repo reported 522 spec files, most of them copies) from
 * inflating every downstream metric.
 */
const PRUNED_DIRS = new Set([
  '.git', '.svn', '.hg',
  '.claude',            // includes .claude/worktrees - agent copies of qa/
  'node_modules',
  'dist', 'build', 'out', 'bin', 'obj',
  'coverage', '.nyc_output',
  'test-results', 'playwright-report', 'blob-report', 'allure-results',
  '.auth',
  '__snapshots__',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  '.venv', 'venv', '__pycache__',
  '.vs', '.vscode', '.idea',
]);

/** Playwright's own default when a config declares no testMatch. */
const DEFAULT_TEST_MATCH = ['**/*.@(spec|test).?(c|m)[jt]s?(x)'];

/** Matched files that are runner lifecycle hooks, not tests. */
const LIFECYCLE_BASENAMES = /^(global-setup|global-teardown|globalSetup|globalTeardown)\.[cm]?[jt]sx?$/;

const CONFIG_BASENAME = /^playwright\.config\.[cm]?[jt]s$/;

// ---------------------------------------------------------------------------
// Glob matching (no dependencies, deterministic)
// ---------------------------------------------------------------------------

/** Quantifier each extglob prefix contributes to its alternation group. */
const EXTGLOB_QUANTIFIER = { '@': '', '?': '?', '*': '*', '+': '+' };

/**
 * Convert a glob to a RegExp. Supports the subset Playwright configs actually
 * use: ** , * , ? , [abc] , {a,b} and the extglobs @() ?() *() +().
 *
 * Written as a scanner rather than chained replaces so that nested braces,
 * character classes and extglobs cannot corrupt each other. Playwright's own
 * default pattern - '**\/*.@(spec|test).?(c|m)[jt]s?(x)' - exercises three of
 * these constructs at once, so a partial implementation silently matches
 * nothing rather than failing loudly.
 */
function globToRegExp(glob) {
  let out = '^';
  let i = 0;

  while (i < glob.length) {
    const c = glob[i];

    // Extglob: @(a|b) ?(a|b) *(a|b) +(a|b). Must be tested before bare '*'
    // and '?', which would otherwise consume the prefix character.
    if (EXTGLOB_QUANTIFIER[c] !== undefined && glob[i + 1] === '(') {
      const close = findClosing(glob, i + 1, '(', ')');
      if (close !== -1) {
        const alts = splitTopLevel(glob.slice(i + 2, close), '|');
        out += '(?:' + alts.map(globToInner).join('|') + ')' + EXTGLOB_QUANTIFIER[c];
        i = close + 1;
        continue;
      }
    }

    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' collapses to an optional path prefix so that '**/a.ts' also
        // matches a bare 'a.ts' at the root of testDir.
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 3; continue; }
        out += '.*'; i += 2; continue;
      }
      out += '[^/]*'; i += 1; continue;
    }

    if (c === '?') { out += '[^/]'; i += 1; continue; }

    // Character class passes through to the regex engine almost verbatim;
    // only the glob negation marker '!' differs from regex '^'.
    if (c === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close !== -1) {
        let body = glob.slice(i + 1, close);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        out += '[' + body + ']';
        i = close + 1;
        continue;
      }
    }

    if (c === '{') {
      const close = findClosing(glob, i, '{', '}');
      if (close === -1) { out += '\\{'; i += 1; continue; }
      const alts = splitTopLevel(glob.slice(i + 1, close));
      out += '(?:' + alts.map(globToInner).join('|') + ')';
      i = close + 1; continue;
    }

    out += escapeRegExp(c);
    i += 1;
  }

  return new RegExp(out + '$');
}

/** Compile an alternation branch without re-anchoring it. */
function globToInner(fragment) {
  const compiled = globToRegExp(fragment).source;
  return compiled.slice(1, -1); // strip ^ and $
}

function findClosing(str, start, open, close) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === open) depth++;
    else if (str[i] === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function splitTopLevel(str, sep = ',') {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of str) {
    if (ch === '{' || ch === '(') depth++;
    if (ch === '}' || ch === ')') depth--;
    if (ch === sep && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

/**
 * Strip block and line comments, preserving string literals.
 *
 * This is not cosmetic. Every config inspected carries a commented-out
 * `// testMatch: ['**\/*.spec.ts'],` line; a regex run over the raw source
 * reads that dead line as live configuration.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (quote) {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i += 1; continue;
    }

    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    out += c; i += 1;
  }

  return out;
}

/**
 * Extract the raw source of a key's value, but only when that key sits at the
 * top level of the exported config object.
 *
 * Depth matters here. Every inspected config declares per-project testMatch
 * entries inside `projects: [...]`, including a `setup` project pointing at a
 * lifecycle hook. A depth-blind regex finds one of those first and mistakes a
 * single lane's file list for the whole suite - which is how a 29-file suite
 * reports as 4. A per-project testMatch narrows which files a project runs; it
 * never defines the suite.
 */
function findTopLevelValue(src, key) {
  // Anchor on the defineConfig CALL, not on the identifier. Every config
  // imports the symbol first ("import { defineConfig } from ..."), and that
  // import's own brace would otherwise be mistaken for the config object.
  const call  = /\bdefineConfig\s*(?:<[^>]*>)?\s*\(/.exec(src);
  const anchor = call ? call.index + call[0].length - 1 : src.indexOf('export default');
  const start  = src.indexOf('{', anchor === -1 ? 0 : anchor);
  if (start === -1) return null;

  let depth = 0;
  let quote = null;

  for (let i = start; i < src.length; i++) {
    const c = src[i];

    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }

    if (c === '{' || c === '[') { depth++; continue; }
    if (c === '}' || c === ']') { depth--; if (depth === 0) return null; continue; }

    if (depth !== 1 || !src.startsWith(key, i)) continue;
    if (/[A-Za-z0-9_$]/.test(src[i - 1] ?? '')) continue;

    const colon = /^\s*:\s*/.exec(src.slice(i + key.length));
    if (!colon) continue;

    return readValue(src, i + key.length + colon[0].length);
  }

  return null;
}

/** Return the raw source of a single value: array, string or regex literal. */
function readValue(src, i) {
  const c = src[i];

  if (c === '[' || c === '{') {
    const close = findClosing(src, i, c, c === '[' ? ']' : '}');
    return close === -1 ? null : src.slice(i, close + 1);
  }

  if (c === '"' || c === "'" || c === '`') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === c) return src.slice(i, j + 1);
    }
    return null;
  }

  if (c === '/') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === '/') return src.slice(i, j + 1);
      if (src[j] === '\n') break;
    }
    return null;
  }

  return null;
}

/** Read a top-level string-or-array option. Regex values are reported, not guessed. */
function readPatternOption(src, key) {
  const raw = findTopLevelValue(src, key);
  if (raw === null) return null;

  if (raw.startsWith('/')) return { patterns: [], unparsed: [raw] };

  const items = [...raw.matchAll(/['"`]([^'"`]+)['"`]/g)].map(m => m[1]);
  return { patterns: items, unparsed: [] };
}

function parseConfig(configPath, repoRoot) {
  const src = stripComments(fs.readFileSync(configPath, 'utf8'));
  const configDir = path.dirname(configPath);
  const warnings = [];

  const testDirRaw = findTopLevelValue(src, 'testDir');
  if (testDirRaw === null) {
    warnings.push(`testDir not statically resolvable in ${relative(repoRoot, configPath)}; defaulting to config directory`);
  }
  const testDir = path.resolve(configDir, testDirRaw ? testDirRaw.slice(1, -1) : '.');

  // Only the top-level testMatch defines the suite. Per-project testMatch
  // narrows which of those files a given project runs; it never widens the
  // suite, and the `setup` project's testMatch points at a lifecycle hook.
  const matchOpt  = readPatternOption(src, 'testMatch');
  const ignoreOpt = readPatternOption(src, 'testIgnore');

  if (matchOpt && matchOpt.unparsed.length) {
    warnings.push(`testMatch is a RegExp in ${relative(repoRoot, configPath)}; using Playwright default instead`);
  }
  if (ignoreOpt && ignoreOpt.unparsed.length) {
    warnings.push(`testIgnore is a RegExp in ${relative(repoRoot, configPath)}; not applied`);
  }

  return {
    configPath,
    testDir,
    testMatch:  matchOpt && matchOpt.patterns.length ? matchOpt.patterns : DEFAULT_TEST_MATCH,
    testMatchIsDefault: !(matchOpt && matchOpt.patterns.length),
    testIgnore: ignoreOpt ? ignoreOpt.patterns : [],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

function walk(dir, onFile, pruned) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (PRUNED_DIRS.has(entry.name)) { pruned.push(full); continue; }
      walk(full, onFile, pruned);
    } else if (entry.isFile()) {
      onFile(full);
    }
  }
}

function relative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function resolveSuite(repoRoot) {
  const pruned      = [];
  const allFiles    = [];
  const configPaths = [];

  walk(repoRoot, (file) => {
    allFiles.push(file);
    if (CONFIG_BASENAME.test(path.basename(file))) configPaths.push(file);
  }, pruned);

  const warnings = [];
  const suites   = [];
  const claimed  = new Set();

  for (const configPath of configPaths.sort()) {
    const cfg = parseConfig(configPath, repoRoot);
    warnings.push(...cfg.warnings);

    const matchers  = cfg.testMatch.map(globToRegExp);
    const ignorers  = cfg.testIgnore.map(globToRegExp);
    const included  = [];
    const excluded  = [];

    if (!fs.existsSync(cfg.testDir)) {
      warnings.push(`testDir does not exist: ${relative(repoRoot, cfg.testDir)} (from ${relative(repoRoot, configPath)})`);
    }

    for (const file of allFiles) {
      if (!isInside(cfg.testDir, file)) continue;

      const relToTestDir = relative(cfg.testDir, file);
      if (!matchers.some(re => re.test(relToTestDir))) continue;

      // A file decided by an explicit rule is decided, not ambiguous: mark it
      // claimed so it cannot also surface in the unclaimed near-miss report.
      if (LIFECYCLE_BASENAMES.test(path.basename(file))) {
        excluded.push({ path: relative(repoRoot, file), rule: 'lifecycle-hook-not-a-test' });
        claimed.add(file);
        continue;
      }

      const hit = cfg.testIgnore.findIndex((_, idx) => ignorers[idx].test(relToTestDir));
      if (hit !== -1) {
        excluded.push({ path: relative(repoRoot, file), rule: `testIgnore:${cfg.testIgnore[hit]}` });
        claimed.add(file);
        continue;
      }

      included.push(relative(repoRoot, file));
      claimed.add(file);
    }

    suites.push({
      id:         relative(repoRoot, path.dirname(configPath)) || '.',
      config:     relative(repoRoot, configPath),
      testDir:    relative(repoRoot, cfg.testDir),
      testMatch:  cfg.testMatch,
      testMatchIsDefault: cfg.testMatchIsDefault,
      testIgnore: cfg.testIgnore,
      count:      included.length,
      files:      included.sort(),
      excluded:   excluded.sort((a, b) => a.path.localeCompare(b.path)),
    });
  }

  // Near-miss report: files that look like tests but no config claims them.
  // These are the honest ambiguities - orphaned suites, stray specs, or a
  // config this parser failed to read.
  const defaultMatchers = DEFAULT_TEST_MATCH.map(globToRegExp);
  const unclaimed = allFiles
    .filter(f => !claimed.has(f))
    .filter(f => defaultMatchers.some(re => re.test(path.basename(f))))
    .filter(f => !LIFECYCLE_BASENAMES.test(path.basename(f)))
    .map(f => relative(repoRoot, f))
    .sort();

  return {
    schema:     'suite-boundary/v1',
    repo:       path.basename(repoRoot),
    confidence: configPaths.length ? 'config-derived' : 'heuristic-none-found',
    totals: {
      suites:          suites.length,
      testFiles:       suites.reduce((n, s) => n + s.count, 0),
      excludedByRule:  suites.reduce((n, s) => n + s.excluded.length, 0),
      unclaimed:       unclaimed.length,
      prunedDirs:      pruned.length,
    },
    suites,
    unclaimed,
    prunedDirs: pruned.map(d => relative(repoRoot, d)).sort(),
    warnings:   [...new Set(warnings)].sort(),
  };
}

function isInside(dir, file) {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printHuman(result) {
  console.log(`Repo:       ${result.repo}`);
  console.log(`Confidence: ${result.confidence}`);
  console.log('');

  for (const suite of result.suites) {
    console.log(`  suite  ${suite.id}`);
    console.log(`    config     ${suite.config}`);
    console.log(`    testDir    ${suite.testDir}`);
    console.log(`    testMatch  ${suite.testMatch.join(', ')}${suite.testMatchIsDefault ? '  (playwright default)' : ''}`);
    console.log(`    testIgnore ${suite.testIgnore.length ? suite.testIgnore.join(', ') : '(none)'}`);
    console.log(`    files      ${suite.count}`);
    for (const ex of suite.excluded) {
      console.log(`    excluded   ${ex.path}  <- ${ex.rule}`);
    }
    console.log('');
  }

  console.log(`  TOTAL test files: ${result.totals.testFiles}  across ${result.totals.suites} suite(s)`);
  console.log(`  pruned dirs:      ${result.totals.prunedDirs}`);

  if (result.unclaimed.length) {
    console.log('');
    console.log(`  UNCLAIMED (look like tests, no config claims them): ${result.unclaimed.length}`);
    for (const u of result.unclaimed.slice(0, 20)) console.log(`    ${u}`);
    if (result.unclaimed.length > 20) console.log(`    ... and ${result.unclaimed.length - 20} more`);
  }

  if (result.warnings.length) {
    console.log('');
    console.log('  WARNINGS');
    for (const w of result.warnings) console.log(`    ${w}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const repoArg = args.find(a => !a.startsWith('--'));

  if (!repoArg) {
    console.error('Usage: node resolve-suite.js <repoPath> [--json] [--out <file>]');
    process.exit(2);
  }

  const repoRoot = path.resolve(repoArg);
  if (!fs.existsSync(repoRoot)) {
    console.error(`Path does not exist: ${repoRoot}`);
    process.exit(2);
  }

  const result = resolveSuite(repoRoot);
  const json = JSON.stringify(result, null, 2);

  const outIdx = args.indexOf('--out');
  if (outIdx !== -1 && args[outIdx + 1]) {
    fs.mkdirSync(path.dirname(path.resolve(args[outIdx + 1])), { recursive: true });
    fs.writeFileSync(path.resolve(args[outIdx + 1]), json + '\n', 'utf8');
  }

  if (args.includes('--json')) console.log(json);
  else printHuman(result);
}

if (require.main === module) main();

module.exports = {
  resolveSuite,
  globToRegExp,
  stripComments,
  findTopLevelValue,
  readPatternOption,
  DEFAULT_TEST_MATCH,
};
