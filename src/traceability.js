/**
 * traceability.js - Join the specification side to the automated side
 *
 * Adapters know how one methodology writes rules and cases down. This does not:
 * it takes whatever the adapter found and whatever case ids the suite carries,
 * and computes the same items for every adapter.
 *
 * Keeping the join here rather than inside each adapter means coverage is
 * computed one way, so two projects using different conventions stay
 * comparable. The convention changes; the arithmetic does not.
 */

'use strict';

function round(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * @param specs  adapter.extract(repoRoot) output
 * @param automatedCaseIds  Set of case ids carried by test titles, upper-cased
 */
/**
 * Risk coverage, kept apart from rule coverage.
 *
 * A rule is something the system is specified to do; a risk is something an
 * analyst found that it might do wrong. They answer different questions and
 * they are counted separately, so that adding a risk register never moves a
 * rule coverage figure people have been comparing across months.
 *
 * A risk counts as covered when a test file cites it. That is weaker than the
 * case-to-rule chain - it is a file citing an id, not a test asserting a value -
 * so the item declares itself inferential and the agent is expected to read the
 * test before treating it as protection.
 */
function riskItems(specs, riskReferences) {
  const declared = specs.risks ?? [];
  if (!declared.length) {
    return {
      'D1.risk-inventory': { present: false, register: null, risks: 0 },
      'D5.risk-coverage': { count: 0, of: 0, ratio: null, evidenceClass: 'inferential', covered: [], uncovered: [] },
    };
  }

  const cited = new Set((riskReferences ?? []).flatMap(entry => entry.risks));
  const ids = declared.map(r => r.id);
  const covered = ids.filter(id => cited.has(id)).sort();
  const uncovered = ids.filter(id => !cited.has(id)).sort();

  return {
    'D1.risk-inventory': {
      present: true,
      register: specs.riskRegister ?? null,
      risks: declared.length,
      bySeverity: tally(declared.map(r => r.severity || 'sin severidad')),
      catalogue: declared,
    },
    'D5.risk-coverage': {
      count: covered.length,
      of: ids.length,
      ratio: ids.length ? round(covered.length / ids.length) : null,
      evidenceClass: 'inferential',
      note: 'a risk counts as covered when a test file cites its id; whether the test protects it is the reader\'s call',
      covered,
      uncovered,
      citingFiles: (riskReferences ?? []).map(e => ({ file: e.file, risks: e.risks })),
    },
  };
}

function tally(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Case ids the specification links to at least one DECLARED rule, upper-cased.
 *
 * Kept next to the join so "linked" means one thing everywhere. It reads the
 * adapter output only and feeds no coverage figure: D5.covered-rules is still
 * computed by buildItems, untouched.
 */
function linkedCaseIds(specs) {
  const declared = new Set(specs.rules.map(r => r.id));
  return new Set(specs.cases
    .filter(c => c.refs.some(r => declared.has(r)))
    .map(c => c.id.toUpperCase()));
}

function buildItems(specs, automatedCaseIds, riskReferences) {
  const declaredRuleIds = new Set(specs.rules.map(r => r.id));

  const linkedCases = specs.cases.filter(c => c.refs.length > 0);

  const coveredRules = new Set();
  for (const c of specs.cases) {
    if (automatedCaseIds.has(c.id.toUpperCase())) for (const r of c.refs) coveredRules.add(r);
  }

  const declaredCaseIds = new Set(specs.cases.map(c => c.id.toUpperCase()));
  const uncovered   = [...declaredRuleIds].filter(r => !coveredRules.has(r)).sort();
  const orphanTests = [...automatedCaseIds].filter(id => !declaredCaseIds.has(id)).sort();

  const risks = riskItems(specs, riskReferences);

  return {
    ...risks,
    'D1.rule-inventory': {
      documents: specs.documents,
      documentsExcluded: specs.documentsExcluded,
      layout: specs.layout,
      rulesDeclared: declaredRuleIds.size,
      // An inventory is present when the repository declares something to trace
      // against, whether it calls those rules or risks. A project that keeps
      // only a risk register is not a project with nothing written down.
      present: declaredRuleIds.size > 0 || (specs.risks ?? []).length > 0,
    },
    'D1.spec-linkage': {
      casesDeclared: specs.cases.length,
      casesWithRuleRef: linkedCases.length,
      ratio: specs.cases.length ? round(linkedCases.length / specs.cases.length) : null,
    },
    'D1.automated-case-ids': { count: automatedCaseIds.size },
    'D5.rule-catalogue': { count: declaredRuleIds.size, rules: specs.rules },
    'D5.covered-rules': {
      count: coveredRules.size,
      of: declaredRuleIds.size,
      ratio: declaredRuleIds.size ? round(coveredRules.size / declaredRuleIds.size) : null,
      rules: [...coveredRules].sort(),
    },
    'D5.uncovered-rules': { count: uncovered.length, rules: uncovered },
    'D5.orphan-tests': {
      count: orphanTests.length,
      note: 'automated cases whose id is declared in no scenario document',
      cases: orphanTests,
    },
    'D5.pending-markers': {
      count: specs.pendingTotal,
      note: 'markers for information the analysis could not confirm',
    },
  };
}

module.exports = { buildItems, linkedCaseIds };
