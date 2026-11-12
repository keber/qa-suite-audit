#!/usr/bin/env node
/**
 * extract-mutation.js - Mutation testing tooling detector (D2.mutation-config)
 *
 * Reports which mutation testing tools the repository configures, and where.
 * It is repository evidence for one half of the D2 level 3 text ("hay mutation
 * testing corriendo"). It does not prove the tool runs: a config can be dead
 * weight, which is why judge-prep lifts a cap on it and never floors a level.
 *
 * Identification is by well-known config file name or by what a manifest
 * declares, never by guessing from a path. The walk reuses the pruning of
 * resolve-suite.js, so a copy of a tool's own sources under node_modules, a
 * build output or an agent worktree cannot pass as this repository's config.
 *
 * Items:
 *   D2.mutation-config   { count, tools: [{ tool, file, via }] }
 *     via: 'config-file' | 'dependency' | 'config-section' | 'build-plugin'
 *
 * Usage:
 *   node extract-mutation.js <repoPath> [--json]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { walk, relative, stripComments } = require('./resolve-suite.js');

/** Config files whose name alone identifies the tool. */
const CONFIG_FILES = [
  { tool: 'stryker',     pattern: /^stryker\.conf\.(?:js|mjs|cjs|json)$/ },
  { tool: 'stryker',     pattern: /^stryker\.config\.[\w.]+$/ },
  { tool: 'stryker',     pattern: /^\.stryker\.conf[\w.]*$/ },
  { tool: 'stryker-net', pattern: /^stryker-config\.json$/ },
  { tool: 'infection',   pattern: /^infection\.json(?:5|\.dist)?$/ },
];

const MUTMUT_CFG  = /^[ \t]*\[mutmut\][ \t]*$/m;
const MUTMUT_TOML = /^[ \t]*\[tool\.mutmut(?:\.[^\]\r\n]+)?\][ \t]*$/m;

const PIT_POM    = /pitest-maven|org\.pitest/;
const PIT_GRADLE = /info\.solidsoft\.pitest|\bpitest\b/;

const STRYKER_SCOPE = '@stryker-mutator/';
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return null; }
}

/** XML comments are dead markup; a commented-out plugin is not configured. */
function stripXmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

function declaresStryker(packageJsonText) {
  let pkg;
  // A manifest that does not parse is skipped, not guessed at: matching the
  // raw text would read a mention in a description as a dependency.
  try { pkg = JSON.parse(packageJsonText); }
  catch { return false; }

  return DEPENDENCY_SECTIONS.some(section => {
    const deps = pkg && typeof pkg[section] === 'object' && pkg[section] ? pkg[section] : {};
    return Object.keys(deps).some(name => name.startsWith(STRYKER_SCOPE));
  });
}

/** What, if anything, one file says about mutation tooling. */
function classify(name, fullPath) {
  for (const { tool, pattern } of CONFIG_FILES) {
    if (pattern.test(name)) return { tool, via: 'config-file' };
  }

  const wantsContent = name === 'package.json' || name === 'setup.cfg' || name === 'pyproject.toml'
    || name === 'pom.xml' || name === 'build.gradle' || name === 'build.gradle.kts';
  if (!wantsContent) return null;

  const text = readText(fullPath);
  if (text === null) return null;

  switch (name) {
    case 'package.json':
      return declaresStryker(text) ? { tool: 'stryker', via: 'dependency' } : null;
    case 'setup.cfg':
      return MUTMUT_CFG.test(text) ? { tool: 'mutmut', via: 'config-section' } : null;
    case 'pyproject.toml':
      return MUTMUT_TOML.test(text) ? { tool: 'mutmut', via: 'config-section' } : null;
    case 'pom.xml':
      return PIT_POM.test(stripXmlComments(text)) ? { tool: 'pitest', via: 'build-plugin' } : null;
    default: // build.gradle, build.gradle.kts
      return PIT_GRADLE.test(stripComments(text)) ? { tool: 'pitest', via: 'build-plugin' } : null;
  }
}

function extractMutationConfig(repoRoot) {
  const tools = [];

  walk(repoRoot, (full) => {
    const hit = classify(path.basename(full), full);
    if (hit) tools.push({ tool: hit.tool, file: relative(repoRoot, full), via: hit.via });
  }, []);

  // Code-unit order, not locale order, so the digest is the same on every machine.
  tools.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0)));

  return { 'D2.mutation-config': { count: tools.length, tools } };
}

function main() {
  const args    = process.argv.slice(2);
  const repoArg = args.find(a => !a.startsWith('--'));

  if (!repoArg) {
    console.error('Usage: node extract-mutation.js <repoPath> [--json]');
    process.exit(2);
  }

  const result = extractMutationConfig(path.resolve(repoArg));
  if (args.includes('--json')) { console.log(JSON.stringify(result, null, 2)); return; }

  const m = result['D2.mutation-config'];
  console.log(`D2.mutation-config   ${m.count} file(s)`);
  for (const t of m.tools) console.log(`  ${t.tool.padEnd(11)} ${t.file}  (${t.via})`);
}

if (require.main === module) main();

module.exports = { extractMutationConfig };
