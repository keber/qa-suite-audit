/**
 * adapters/qa-framework.js - Traceability adapter for @keber/qa-framework
 *
 * Teaches the instrument how this methodology writes rules and cases down:
 *
 *   rules     RN- and FL- ids owning a heading in 01-business-rules.md or
 *             02-workflows.md, under module-<x>/submodule-<y>/
 *   cases     TC- ids declared in 05-test-scenarios.md
 *   linkage   rule ids appearing inside the scope of a case declaration
 *
 * Format independence
 * -------------------
 * Projects using this methodology still write scenarios three different ways: a
 * markdown table whose last column lists rule ids, a per-case section with a
 * field table, and a prose list with no case ids at all. Parsing one canonical
 * layout would score two of the three as untraceable because of their
 * formatting, so linkage is computed by co-occurrence inside a bounded scope.
 *
 * Declaration versus mention
 * --------------------------
 * A rule is DECLARED where it owns a heading. A rule id appearing in a scenario
 * note is a REFERENCE. Treating mentions as declarations would let a suite
 * invent coverage by citing rules that were never written down.
 *
 * This file is the entire coupling between the instrument and the methodology.
 * Everything outside src/adapters/ reads runner configs, test source and
 * pipelines, and knows nothing about qa/ or about rule id shapes.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');

const risks = require('./risks.js');

// ---------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------

/** Business rule: RN-ADM-CON-001. Flow: FL-ADM-CON-001. */
const RULE_ID = /\b(RN|FL)-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+\b/g;
/** Test case: TC-CON-002, TC-BK-ASOC-001, TC-0014. */
const CASE_ID = /\bTC-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+\b|\bTC-\d+\b/g;

const HEADING   = /^(#{1,6})\s+(.*)$/;
const TABLE_ROW = /^\s*\|/;

/** The methodology's marker for information that was not confirmed. */
const PENDING = /PENDING-CODE/g;

const RULES_DOC     = /^01-business-rules\.md$/i;
const FLOWS_DOC     = /^02-workflows\.md$/i;
const SCENARIOS_DOC = /^05-test-scenarios\.md$/i;

const MODULE_DIR    = /^module-/i;
const SUBMODULE_DIR = /^submodule-/i;

const PRUNED_DIRS = new Set([
  '.git', '.claude', 'node_modules', 'dist', 'build', 'out',
  'coverage', 'test-results', 'playwright-report', '.auth', '.vs', '.vscode', '.idea',
]);

const SPECS_CANDIDATES = [
  ['qa', '01-specifications'],
  ['specs'],
  ['docs', 'specs'],
];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function findSpecsRoot(repoRoot) {
  for (const parts of SPECS_CANDIDATES) {
    const candidate = path.join(repoRoot, ...parts);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function detect(repoRoot) {
  return findSpecsRoot(repoRoot) !== null;
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

function walkMarkdown(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!PRUNED_DIRS.has(entry.name)) walkMarkdown(full, out);
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function rel(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function matchAll(text, re) {
  re.lastIndex = 0;
  return [...new Set(text.match(re) ?? [])];
}

// ---------------------------------------------------------------------------
// Specification boundary
// ---------------------------------------------------------------------------

/**
 * Restrict the inventory to documents that are actually specifications.
 *
 * One repository keeps 747 of its 867 markdown files under
 * 01-specifications/source/ado-workitems-cache - a cache of tracker items, not
 * specifications. Counting those inflates the rule inventory the way a vendored
 * node_modules inflates a test count.
 */
function selectSpecDocuments(specsRoot, docs) {
  const structured = [];
  const excluded   = [];

  for (const doc of docs) {
    const parts = path.relative(specsRoot, doc).split(path.sep);
    const isSpec = parts.length === 3 && MODULE_DIR.test(parts[0]) && SUBMODULE_DIR.test(parts[1]);
    if (isSpec) structured.push(doc);
    else excluded.push(doc);
  }

  if (structured.length) return { docs: structured, excluded, layout: 'framework' };
  return { docs, excluded: [], layout: 'unstructured' };
}

// ---------------------------------------------------------------------------
// Declarations and scopes
// ---------------------------------------------------------------------------

/** Ids that own a heading: the difference between existing and being mentioned. */
function declaredInHeadings(lines, idPattern) {
  const found = [];

  lines.forEach((line, idx) => {
    const h = HEADING.exec(line);
    if (!h) return;
    for (const id of matchAll(h[2], idPattern)) {
      found.push({ id, title: cleanTitle(h[2], id), line: idx + 1, level: h[1].length });
    }
  });

  return found;
}

function cleanTitle(heading, id) {
  return heading
    .replace(id, '')
    .replace(/^[\s:.\p{Pd}]+/u, '')
    .replace(/[\s:.\p{Pd}]+$/u, '')
    .trim();
}

/**
 * Every case id declaration in a scenario document, with the text that belongs
 * to it: a table row, or a heading and its section.
 */
function caseScopes(lines) {
  const scopes = [];

  lines.forEach((line, idx) => {
    const heading = HEADING.exec(line);

    if (heading) {
      const ids = matchAll(heading[2], CASE_ID);
      if (!ids.length) return;

      const level = heading[1].length;
      let end = lines.length;
      for (let j = idx + 1; j < lines.length; j++) {
        const next = HEADING.exec(lines[j]);
        if (next && next[1].length <= level) { end = j; break; }
      }

      for (const id of ids) {
        scopes.push({ id, kind: 'section', line: idx + 1, text: lines.slice(idx, end).join('\n') });
      }
      return;
    }

    if (TABLE_ROW.test(line)) {
      const cells = line.split('|').map(c => c.trim());
      const first = cells.find(c => c.length > 0) ?? '';
      // Only a row whose FIRST populated cell is the case id declares it.
      for (const id of matchAll(first, CASE_ID)) {
        scopes.push({ id, kind: 'table-row', line: idx + 1, text: line });
      }
    }
  });

  return scopes;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extract(repoRoot) {
  const specsRoot = findSpecsRoot(repoRoot);
  if (specsRoot === null) {
    return { specsRoot: null, layout: 'none', rules: [], cases: [], risks: [], riskRegister: null, pendingTotal: 0, documents: 0, documentsExcluded: 0, byDocument: [] };
  }

  // The risk register sits at the specification root, outside the
  // module/submodule layout, so the document selection below never sees it.
  const register = risks.extract(repoRoot, specsRoot);

  const all = walkMarkdown(specsRoot);
  const { docs, excluded, layout } = selectSpecDocuments(specsRoot, all);

  const rules = new Map();
  const cases = new Map();
  const byDoc = [];
  let pendingTotal = 0;

  for (const doc of docs) {
    const text   = fs.readFileSync(doc, 'utf8');
    const lines  = text.split(/\r?\n/);
    const name   = path.basename(doc);
    const relDoc = rel(repoRoot, doc);

    const pending = (text.match(PENDING) ?? []).length;
    pendingTotal += pending;

    const isRuleDoc = RULES_DOC.test(name) || FLOWS_DOC.test(name);
    const declared  = isRuleDoc ? declaredInHeadings(lines, RULE_ID) : [];

    for (const d of declared) {
      if (!rules.has(d.id)) rules.set(d.id, { id: d.id, title: d.title, file: relDoc, line: d.line });
    }

    let scopes = [];
    if (SCENARIOS_DOC.test(name)) {
      scopes = caseScopes(lines);
      for (const s of scopes) {
        const refs = matchAll(s.text, RULE_ID);
        const prev = cases.get(s.id);
        if (prev) { for (const r of refs) prev.refs.add(r); continue; }
        cases.set(s.id, { id: s.id, file: relDoc, line: s.line, kind: s.kind, refs: new Set(refs) });
      }
    }

    if (declared.length || scopes.length || pending) {
      byDoc.push({ file: relDoc, rulesDeclared: declared.length, casesDeclared: scopes.length, pendingMarkers: pending });
    }
  }

  return {
    specsRoot: rel(repoRoot, specsRoot),
    layout,
    risks: register.risks,
    riskRegister: register.file,
    documents: docs.length,
    documentsExcluded: excluded.length,
    rules: [...rules.values()].sort((a, b) => a.id.localeCompare(b.id)),
    cases: [...cases.values()].map(c => ({ ...c, refs: [...c.refs].sort() })),
    pendingTotal,
    byDocument: byDoc,
  };
}

module.exports = {
  name: 'qa-framework',
  description: 'rules in 01-business-rules.md, cases in 05-test-scenarios.md, linked by co-occurrence',
  caseIdPattern: /\bTC-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+\b|\bTC-\d+\b/i,
  riskRefScanner: risks.referencedRisks,
  detect,
  extract,
  // exported for tests
  caseScopes,
  declaredInHeadings,
  findSpecsRoot,
  selectSpecDocuments,
  RULE_ID,
  CASE_ID,
};
