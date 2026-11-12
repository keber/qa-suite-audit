#!/usr/bin/env node
/**
 * validate-verdict.js - Check a verdict against the evidence it claims to read
 *
 * The judgment protocol is a set of rules an agent is asked to follow. This
 * turns the ones that can be checked into something that fails rather than
 * something that is trusted: a rule nobody verifies is a preference.
 *
 * What it catches, in the order it matters:
 *
 *   stale     the verdict was written against different evidence
 *   fabricated a citation names an item or a file that does not exist
 *   unbounded a level sits outside the range the evidence permits
 *   overridden a level the evidence settled was changed anyway
 *   arithmetic the total does not equal the levels, or the eliminatory rule
 *             was not applied
 *
 * Every one of those is a real failure mode of a generated verdict, and every
 * one of them produces a document that looks exactly as authoritative as a
 * correct one. That is the whole reason this file exists.
 *
 * Usage:
 *   node validate-verdict.js <judgment-input.json> <verdict.json>
 *
 * Exit code 0 when valid, 1 when not.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const CONFIDENCE = new Set(['high', 'medium', 'low']);
const OBSERVATION = /^(.+?):(\d+)$/;
const MIN_REASONING = 40;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(input, verdict) {
  const errors = [];
  const warnings = [];
  const fail = (code, message) => errors.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });

  // -- Identity -------------------------------------------------------------

  if (verdict.schema !== 'verdict/v1') {
    fail('schema', `expected schema verdict/v1, got ${JSON.stringify(verdict.schema)}`);
  }

  if (verdict.repo !== input.repo) {
    fail('repo-mismatch', `verdict is for ${JSON.stringify(verdict.repo)}, evidence is for ${JSON.stringify(input.repo)}`);
  }

  // A verdict bound to different evidence is not a disagreement to reconcile.
  // It describes a repository state that no longer exists.
  if (verdict.evidenceDigest !== input.evidenceDigest) {
    fail('stale-digest',
      `verdict digest ${short(verdict.evidenceDigest)} does not match evidence ${short(input.evidenceDigest)}; re-judge rather than adjust`);
    return report(errors, warnings, null);
  }

  // -- Coverage -------------------------------------------------------------

  const levels = Array.isArray(verdict.levels) ? verdict.levels : [];
  if (!levels.length) {
    fail('no-levels', 'verdict contains no levels');
    return report(errors, warnings, null);
  }

  const seen = new Map();
  for (const entry of levels) {
    if (seen.has(entry.dimension)) {
      fail('duplicate-dimension', `dimension ${entry.dimension} is judged more than once`);
      continue;
    }
    seen.set(entry.dimension, entry);
  }

  for (const d of input.dimensions) {
    if (!seen.has(d.dimension)) fail('missing-dimension', `dimension ${d.dimension} (${d.name}) has no level`);
  }
  for (const n of seen.keys()) {
    if (!input.dimensions.some(d => d.dimension === n)) {
      fail('unknown-dimension', `dimension ${n} is not in the evidence`);
    }
  }

  // -- Per dimension --------------------------------------------------------

  const knownItems = new Set([
    ...Object.keys(input.items.source),
    ...Object.keys(input.items.rules),
    ...Object.keys(input.items.pipelines),
  ]);
  // A citable file is anything the evidence itself names. Test files answer the
  // questions about the suite; rule documents answer the questions about the
  // oracle and about coverage, and those cannot be settled by reading tests.
  const knownFiles = new Set([
    ...(input.suiteFiles ?? []),
    ...((input.items?.rules?.['D5.rule-catalogue']?.rules ?? []).map(r => r.file)),
    ...((input.items?.rules?.['D1.risk-inventory']?.catalogue ?? []).map(r => r.file)),
    input.items?.rules?.['D1.risk-inventory']?.register,
  ].filter(Boolean));

  for (const d of input.dimensions) {
    const entry = seen.get(d.dimension);
    if (!entry) continue;
    const at = `D${d.dimension}`;

    if (!Number.isInteger(entry.level)) {
      fail('level-type', `${at} level must be an integer, got ${JSON.stringify(entry.level)}`);
      continue;
    }

    if (entry.level < d.bounds.min || entry.level > d.bounds.max) {
      fail('out-of-bounds',
        `${at} level ${entry.level} is outside ${d.bounds.min}..${d.bounds.max}` +
        (d.constraints.length ? ` (${d.constraints.map(c => c.effect).join('; ')})` : ''));
    }

    if (d.determined !== null && entry.level !== d.determined) {
      fail('overrides-evidence',
        `${at} was settled at ${d.determined} by evidence; the verdict says ${entry.level}`);
    }

    if (!CONFIDENCE.has(entry.confidence)) {
      fail('confidence', `${at} confidence must be high, medium or low, got ${JSON.stringify(entry.confidence)}`);
    }

    // Citations
    const citations = Array.isArray(entry.citations) ? entry.citations : [];
    for (const c of citations) {
      if (!knownItems.has(c)) fail('fabricated-item', `${at} cites item ${JSON.stringify(c)}, which does not exist`);
    }

    if (d.determined === null) {
      const required = d.mustCite.filter(m => citations.includes(m));
      if (!required.length) {
        fail('uncited', `${at} cites none of its required items: ${d.mustCite.join(', ')}`);
      }
    }

    // Observations must point at a real test file at a plausible line.
    for (const obs of entry.observations ?? []) {
      const m = OBSERVATION.exec(obs);
      if (!m) {
        fail('observation-format', `${at} observation ${JSON.stringify(obs)} is not file:line`);
        continue;
      }
      if (knownFiles.size && !knownFiles.has(m[1])) {
        fail('fabricated-file', `${at} observes ${JSON.stringify(m[1])}, which is not in the resolved suite`);
      }
    }

    // Reasoning
    const reasoning = typeof entry.reasoning === 'string' ? entry.reasoning.trim() : '';
    if (reasoning.length < MIN_REASONING) {
      fail('thin-reasoning', `${at} reasoning is ${reasoning.length} characters; a level needs an argument, not a label`);
    }

    // A level at the top of an OPEN range, asserted without having read
    // anything, is the shape a confident guess takes. A level at a range the
    // evidence already narrowed is pinned rather than claimed, so warning about
    // it trains the reader to ignore warnings.
    const rangeWasNarrowed = d.constraints.some(c => /capped|determined/.test(c.effect ?? ''));

    if (d.determined === null && !rangeWasNarrowed
        && entry.level === d.bounds.max && d.bounds.max > d.bounds.min
        && !(entry.observations ?? []).length) {
      warn('top-without-observation',
        `${at} claims the highest level its evidence allows but cites no file it read`);
    }

    if (entry.confidence === 'low' && entry.level > d.bounds.min) {
      warn('low-confidence-not-lowest',
        `${at} is low confidence but not at the lowest permitted level; the protocol says never guess upward`);
    }
  }

  // -- Arithmetic -----------------------------------------------------------

  const sum = [...seen.values()].reduce((n, e) => n + (Number.isInteger(e.level) ? e.level : 0), 0);
  if (verdict.obtained !== sum) {
    fail('bad-total', `obtained is ${verdict.obtained} but the levels sum to ${sum}`);
  }
  if (verdict.attainable !== input.attainable) {
    fail('bad-attainable', `attainable is ${verdict.attainable}, evidence says ${input.attainable}`);
  }

  // -- Eliminatory ----------------------------------------------------------

  const zeroed = input.dimensions
    .filter(d => d.eliminatory && seen.get(d.dimension)?.level === 0)
    .map(d => d.dimension);

  if (zeroed.length && verdict.eliminated !== true) {
    fail('missed-elimination',
      `dimension(s) ${zeroed.join(', ')} are eliminatory and scored 0, but the verdict does not report elimination`);
  }
  if (!zeroed.length && verdict.eliminated === true) {
    fail('false-elimination', 'the verdict reports elimination but no eliminatory dimension scored 0');
  }
  if (zeroed.length) {
    const declared = [...(verdict.eliminatedBy ?? [])].sort().join(',');
    if (declared !== zeroed.sort().join(',')) {
      fail('elimination-mismatch', `eliminatedBy should be [${zeroed.join(', ')}]`);
    }
  }

  // -- Source bands must not reappear ---------------------------------------

  const text = JSON.stringify(verdict).toLowerCase();
  for (const band of ['aprueba con distincion', 'no aprueba todavia', '/21']) {
    if (text.includes(band)) {
      fail('source-bands', `the verdict uses the source rubric's verdict scale (${JSON.stringify(band)}); v1 reports obtained over attainable`);
    }
  }

  return report(errors, warnings, { obtained: sum, attainable: input.attainable, eliminated: zeroed.length > 0 });
}

function report(errors, warnings, summary) {
  return { valid: errors.length === 0, errors, warnings, summary };
}

function short(digest) {
  return typeof digest === 'string' ? digest.slice(0, 16) : String(digest);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHuman(result, input, verdict) {
  if (result.valid) {
    console.log(`VALID   ${verdict.repo}   ${result.summary.obtained}/${result.summary.attainable}` +
      (result.summary.eliminated ? '   ELIMINATED' : ''));
  } else {
    console.log(`INVALID ${verdict.repo ?? '(unknown)'}   ${result.errors.length} error(s)`);
  }

  for (const e of result.errors)   console.log(`  ERROR  [${e.code}] ${e.message}`);
  for (const w of result.warnings) console.log(`  WARN   [${w.code}] ${w.message}`);
}

function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (args.length < 2) {
    console.error('Usage: node validate-verdict.js <judgment-input.json> <verdict.json>');
    process.exit(2);
  }

  const input   = JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8'));
  const verdict = JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8'));

  const result = validate(input, verdict);

  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else printHuman(result, input, verdict);

  process.exit(result.valid ? 0 : 1);
}

if (require.main === module) main();

module.exports = { validate };
