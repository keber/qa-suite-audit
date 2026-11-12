/**
 * adapters/risks.js - Risk register reader
 *
 * Some projects keep a risk register alongside their specifications: risks
 * found while exploring the system, each with a severity, the code evidence
 * behind it, and the module it belongs to. A regression test written against
 * one of those cites it in its header.
 *
 * This is NOT part of the qa-framework methodology. Nothing in the framework's
 * templates, skills or scripts mentions a risk register; one project grew the
 * convention on its own. It lives in its own file so that the methodology
 * adapter stays a description of the methodology, and so this can be lifted out
 * or generalized later without untangling it from anything else.
 *
 * Risks are kept SEPARATE from business rules on purpose. A rule is something
 * the system is specified to do; a risk is something an analyst found that it
 * might do wrong. Folding twenty risks into a catalogue of four hundred ninety
 * rules would move a coverage percentage that people compare across months,
 * and it would answer a question nobody asked with a number nobody can read.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const REGISTER_FILE = /^_risks\.md$/i;

/** A risk id as it appears in the register's first column: R-01, R-18. */
const RISK_ID = /^R-\d+$/;

/** The same id anywhere in a test file, including inside a header comment. */
const RISK_REFERENCE = /\bR-\d{2}\b/g;

const TABLE_ROW = /^\s*\|/;

function registerPath(specsRoot) {
  if (!specsRoot || !fs.existsSync(specsRoot)) return null;

  const entries = fs.readdirSync(specsRoot, { withFileTypes: true });
  const hit = entries.find(e => e.isFile() && REGISTER_FILE.test(e.name));
  return hit ? path.join(specsRoot, hit.name) : null;
}

/**
 * Read the risk register.
 *
 * A risk is DECLARED by owning the first cell of a table row, the same way a
 * business rule is declared by owning a heading. The register also carries
 * tables of testing constraints (C-NN) and priorities (P0-N), and risk ids are
 * quoted inside other risks' prose; neither of those declares anything, and the
 * first-cell rule excludes both without a list of exceptions.
 */
function readRegister(file, repoRoot) {
  const text  = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const risks = [];
  const seen  = new Set();

  lines.forEach((line, idx) => {
    if (!TABLE_ROW.test(line)) return;

    const cells = line.split('|').map(c => c.trim());
    const first = cells.find(c => c.length > 0) ?? '';
    if (!RISK_ID.test(first) || seen.has(first)) return;

    seen.add(first);
    risks.push({
      id: first,
      severity: stripEmphasis(cells[2] ?? ''),
      title: firstSentence(stripEmphasis(cells[3] ?? '')),
      module: stripEmphasis(cells[5] ?? '') || null,
      file: path.relative(repoRoot, file).split(path.sep).join('/'),
      line: idx + 1,
    });
  });

  return risks;
}

function stripEmphasis(cell) {
  return cell.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

/** Risk prose runs long; the first sentence is what a report can show. */
function firstSentence(text) {
  const cut = /^(.*?[.:])\s/.exec(text);
  return (cut ? cut[1] : text).slice(0, 160).trim();
}

/**
 * Which risks a piece of test source cites.
 *
 * Read from the RAW file, comments included. That is deliberate: the citation
 * lives in the header comment that explains why the test exists, which is
 * exactly the text every other scan in this instrument masks away.
 */
function referencedRisks(source) {
  RISK_REFERENCE.lastIndex = 0;
  return [...new Set(source.match(RISK_REFERENCE) ?? [])].sort();
}

function extract(repoRoot, specsRoot) {
  const file = registerPath(specsRoot);
  if (!file) return { present: false, file: null, risks: [] };

  return {
    present: true,
    file: path.relative(repoRoot, file).split(path.sep).join('/'),
    risks: readRegister(file, repoRoot),
  };
}

module.exports = { extract, readRegister, referencedRisks, registerPath, RISK_ID, RISK_REFERENCE };
