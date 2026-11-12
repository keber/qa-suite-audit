/**
 * suite-type.js - D0.suite-type-signals: what a suite says about its own kind
 *
 * Step 0 of docs/JUDGMENT-PROTOCOL.md asks what kind of suite is being read
 * before anything is scored: a regression net (expected values come from the
 * specification), a defect harness (asserts known defects on purpose), a
 * characterization suite (freezes current behaviour) or a mix by directory.
 *
 * This file emits SIGNALS ONLY. The classification is the judge's, and the
 * validator checks it is declared and cites these signals. A script that wrote
 * the type would leave nothing for the validator to check, and a type that any
 * bound read would be a bound the judge could move by declaring something
 * (issue #10, deliberately open). So no field here is a type, a level or a
 * score, and nothing in judge-prep reads this item.
 *
 * Groups are one per suite and per top-level directory under the suite's test
 * root (files directly in the root group as "."). Every count is a number of
 * TESTS, skipped ones included, so each is comparable against `tests`.
 */

'use strict';

const path = require('path');

const { linkedCaseIds } = require('./traceability.js');

/**
 * A defect id in a test title or in a file name: DEF, BUG, DEFECT, ISSUE, INC or
 * HOTFIX, then - or _, then letters, digits or hyphens ending in a digit
 * (BUG-0042, issue_17, DEF-AB-3). Case-insensitive.
 *
 * The edges are explicit rather than \b: \b treats "_" as a word character, so
 * it would miss "checkout_bug-42.spec.ts" and "BUG-42_login.spec.ts", where "_"
 * is a separator. A letter or digit directly before the keyword ("debug-42",
 * "rebug-42") or directly after the final digit ("BUG-42x") is not an edge, so
 * those stay out.
 * Distinct from a case id (TC-CON-001), which the adapter reads and which names
 * a scenario, not a known defect. Documented in docs/EVIDENCE-CATALOGUE.md (D0).
 */
const DEFECT_ID = /(?<![A-Z0-9])(?:DEF|BUG|DEFECT|ISSUE|INC|HOTFIX)[-_][A-Z0-9-]*\d(?![A-Z0-9])/i;

const MAX_EXAMPLES = 5;

/** First path segment under the test root, or '.' for a file directly in it. */
function directoryOf(file, testDir) {
  const rel = testDir && file.startsWith(`${testDir}/`) ? file.slice(testDir.length + 1) : file;
  const parts = rel.split('/');
  return parts.length > 1 ? parts[0] : '.';
}

function summarize(tests, linked) {
  const ref = (t) => `${t.file}:${t.line}`;
  const defects = tests.filter(t => DEFECT_ID.test(t.title) || DEFECT_ID.test(path.posix.basename(t.file)));

  return {
    tests: tests.length,
    defectIds: { count: defects.length, examples: defects.map(ref).sort().slice(0, MAX_EXAMPLES) },
    expectedFailures: { count: tests.filter(t => t.expectedFailures > 0).length },
    snapshotAssertions: { count: tests.filter(t => t.snapshotAssertions > 0).length },
    caseIds: { count: tests.filter(t => t.caseId).length },
    caseIdsLinkedToRules: { count: tests.filter(t => t.caseId && linked.has(t.caseId.toUpperCase())).length },
  };
}

/**
 * @param source    extractEvidence output: suites with their per-test records
 * @param boundary  resolveSuite output: carries each suite's resolved testDir
 * @param specs     adapter.extract output, for the case-to-rule link
 */
function suiteTypeSignals(source, boundary, specs) {
  const linked = linkedCaseIds(specs);
  const testDirs = new Map(boundary.suites.map(s => [s.id, s.testDir]));

  return {
    evidenceClass: 'inferential',
    note: 'signals only: the suite type is declared by the verdict, never computed here; every count is a number of tests',
    vocabulary: 'DEFECT_ID in src/suite-type.js (documented in docs/EVIDENCE-CATALOGUE.md, D0.suite-type-signals)',
    suites: source.suites.map(suite => {
      const testDir = testDirs.get(suite.id) ?? '';
      const byDir = new Map();
      for (const t of suite.tests) {
        const dir = directoryOf(t.file, testDir);
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir).push(t);
      }

      return {
        suite: suite.id,
        testDir,
        directories: [...byDir.keys()].sort().map(directory => ({
          directory,
          // The key a verdict uses for this group, written once here so nobody
          // has to rebuild it from a suite id and a directory.
          key: `${suite.id}/${directory}`,
          ...summarize(byDir.get(directory), linked),
        })),
      };
    }),
  };
}

/** Every group key in the item, in order. A mixed verdict must cover all of them. */
function groupKeys(item) {
  return (item?.suites ?? []).flatMap(s => (s.directories ?? []).map(d => d.key));
}

module.exports = { suiteTypeSignals, groupKeys, DEFECT_ID, MAX_EXAMPLES };
