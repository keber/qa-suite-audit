/**
 * report/list.js - Terminal renderer
 *
 * Built for the case where someone runs the audit and reads the answer in the
 * next ten seconds. The headline is the result and whether it is trustworthy;
 * the detail is there for whoever keeps reading.
 *
 * Two things are never allowed to be quiet: an elimination, and a level decided
 * by a calibrated threshold rather than by the rubric text. Both change what the
 * number means, and both are easy to miss in a table.
 */

'use strict';

const { buildModel } = require('./model.js');

const BAR = { filled: '#', empty: '.' };

function bar(level, ceiling) {
  if (level === null) return '?'.repeat(Math.max(ceiling, 1));
  return BAR.filled.repeat(level) + BAR.empty.repeat(Math.max(ceiling - level, 0));
}

function render(input, verdict, options = {}) {
  const m = buildModel(input, verdict);
  const out = [];
  const w = (line = '') => out.push(line);

  w(`Suite audit  ${m.repo}`);
  w(`  adapter ${m.adapter.name}   evidence ${m.shortDigest}   ${m.suiteFiles} test file(s)`);
  if (m.suiteType) {
    w(`  suite type ${printable(m.suiteType.type)}`);
    const rows = m.suiteType.byDirectory.map(e => ({ directory: printable(e.directory), type: printable(e.type) }));
    const width = Math.max(0, ...rows.map(e => e.directory.length));
    for (const e of rows) w(`    ${e.directory.padEnd(width)}  ${e.type}`);
  }
  w('');

  // -- Headline -------------------------------------------------------------

  if (m.eliminated) {
    w(`  RESULT   ${m.obtained}/${m.attainable}   DOES NOT PASS`);
    w(`           eliminated by dimension ${m.eliminatedBy.join(' and ')} scoring 0`);
  } else {
    w(`  RESULT   ${m.obtained}/${m.attainable}`);
  }
  w(`           v1 reads the repository only; ${m.attainable} of 21 points are reachable at all`);
  w('');

  // -- Dimensions -----------------------------------------------------------

  for (const d of m.dimensions) {
    const level = d.level === null ? '?' : d.level;
    const flags = [];
    if (d.eliminatory && d.level === 0) flags.push('ELIMINATORY');
    if (d.determined !== null) flags.push('settled by evidence');
    if (d.decidedByCalibration) flags.push('calibrated threshold');
    if (d.confidence === 'low') flags.push('low confidence');

    w(`  D${d.n} ${d.name.padEnd(16)} ${String(level)}/${d.ceiling}  ${bar(d.level, d.ceiling).padEnd(4)}` +
      (flags.length ? `  ${flags.join(', ')}` : ''));

    if (options.verbose) {
      if (d.reasoning) w(`       ${wrap(d.reasoning, 68, '       ')}`);
      if (d.citations.length)   w(`       cites ${d.citations.join(', ')}`);
      if (d.observations.length) w(`       read  ${d.observations.join(', ')}`);
      if (d.cappedByEvidence)   w(`       ceiling ${d.ceiling}: ${d.ceilingReason}`);
      w('');
    }
  }

  // -- What the number hides ------------------------------------------------

  if (m.risks) {
    w('');
    w(`  RISK REGISTER  ${m.risks.covered}/${m.risks.total} risks have a test that cites them` +
      `  (${Object.entries(m.risks.bySeverity).map(([k, v]) => `${k} ${v}`).join(', ')})`);
    w(`    ${m.risks.register}`);
    w('    Counted apart from rule coverage and inferential: a file cites an id,');
    w('    which is not the same as a test asserting the behaviour.');
  }

  if (m.calibratedDecisions.length) {
    w('');
    w('  DECIDED BY CALIBRATION, NOT BY THE RUBRIC TEXT');
    for (const c of m.calibratedDecisions) {
      for (const k of c.constraints) {
        w(`    D${c.dimension} ${c.name}: ${k.observed}`);
        w(`       ${k.effect}`);
      }
    }
    w('    Move a value in thresholds.json and this result moves with it.');
  }

  if (m.lowConfidence.length) {
    w('');
    w(`  LOW CONFIDENCE on dimension(s) ${m.lowConfidence.join(', ')} - the evidence did not settle the question`);
  }

  if (m.thresholdObjections.length) {
    w('');
    w('  THRESHOLD OBJECTIONS RAISED');
    for (const o of m.thresholdObjections) w(`    ${typeof o === 'string' ? o : JSON.stringify(o)}`);
  }

  if (m.notes) {
    w('');
    w(`  NOTES  ${wrap(m.notes, 68, '         ')}`);
  }

  return out.join('\n');
}

/**
 * A directory name comes from the audited repository and goes to a terminal, so
 * it is stripped of anything a terminal would act on: ANSI escape sequences
 * first (so their printable tail does not survive), then every remaining
 * control character, which also removes a newline that could forge a line.
 */
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function printable(text) {
  return String(text).replace(ANSI_SEQUENCE, '').replace(CONTROL_CHARS, '');
}

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';

  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) { lines.push(line.trim()); line = word; }
    else line += ' ' + word;
  }
  if (line.trim()) lines.push(line.trim());

  return lines.join('\n' + indent);
}

module.exports = { render };
