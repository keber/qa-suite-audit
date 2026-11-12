#!/usr/bin/env node
/**
 * qa-suite-audit - CLI
 *
 *   evidence <repo> [--out <file>]                     gather evidence and bound the judgment
 *   validate <input.json> <verdict.json>               check a verdict against its evidence
 *   report   <input.json> <verdict.json> [--format]    render list (default), html or allure
 *
 * The three verbs are the three phases, in order. A verdict is written between
 * `evidence` and `validate`, by a person or by an agent following
 * docs/JUDGMENT-PROTOCOL.md. This tool never writes one: an instrument that
 * produced its own verdict would have nothing left to check it against.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { prepare }  = require('../src/judge-prep.js');
const { validate } = require('../src/validate-verdict.js');

const reporters = {
  list:   require('../src/report/list.js'),
  html:   require('../src/report/html.js'),
  allure: require('../src/report/allure.js'),
};

function flag(args, name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function usage(code) {
  console.error([
    'Usage:',
    '  qa-suite-audit evidence <repo> [--out <file>] [--json]',
    '  qa-suite-audit validate <input.json> <verdict.json> [--json]',
    '  qa-suite-audit report   <input.json> <verdict.json> [--format list|html|allure] [--out <path>] [--verbose]',
  ].join('\n'));
  process.exit(code);
}

function cmdEvidence(args) {
  const repo = args.find(a => !a.startsWith('--'));
  if (!repo) usage(2);

  const result = prepare(path.resolve(repo));
  const json   = JSON.stringify(result, null, 2);
  const out    = flag(args, 'out');

  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), json + '\n', 'utf8');
    console.error(`evidence written to ${out}`);
  }

  if (args.includes('--json') || !out) console.log(json);
}

function cmdValidate(args) {
  const files = args.filter(a => !a.startsWith('--'));
  if (files.length < 2) usage(2);

  const result = validate(readJson(files[0]), readJson(files[1]));

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.valid ? `VALID   ${result.summary.obtained}/${result.summary.attainable}` : `INVALID ${result.errors.length} error(s)`);
    for (const e of result.errors)   console.log(`  ERROR  [${e.code}] ${e.message}`);
    for (const w of result.warnings) console.log(`  WARN   [${w.code}] ${w.message}`);
  }

  process.exit(result.valid ? 0 : 1);
}

function cmdReport(args) {
  const files = args.filter(a => !a.startsWith('--'));
  if (files.length < 2) usage(2);

  const input   = readJson(files[0]);
  const verdict = readJson(files[1]);

  // A report is a claim about a suite. Rendering one from a verdict that does
  // not match its evidence would publish a conclusion drawn from a repository
  // state that no longer exists.
  const check = validate(input, verdict);
  if (!check.valid) {
    console.error('refusing to report an invalid verdict:');
    for (const e of check.errors) console.error(`  [${e.code}] ${e.message}`);
    process.exit(1);
  }

  const format = flag(args, 'format') ?? 'list';
  const out    = flag(args, 'out');

  if (!reporters[format]) {
    console.error(`unknown format ${format}; expected list, html or allure`);
    process.exit(2);
  }

  if (format === 'allure') {
    const dir = out ?? 'allure-results';
    const written = reporters.allure.write(input, verdict, path.resolve(dir));
    console.error(`${written.length} file(s) written to ${dir}`);
    return;
  }

  const text = reporters[format].render(input, verdict, { verbose: args.includes('--verbose') });

  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), text, 'utf8');
    console.error(`report written to ${out}`);
  } else {
    console.log(text);
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'evidence': return cmdEvidence(args);
    case 'validate': return cmdValidate(args);
    case 'report':   return cmdReport(args);
    default:         return usage(command ? 2 : 0);
  }
}

main();
