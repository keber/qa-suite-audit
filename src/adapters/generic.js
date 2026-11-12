/**
 * adapters/generic.js - The fallback traceability adapter
 *
 * Matches any repository. It knows no rule document layout and no linkage
 * convention, so it reports an empty rule inventory and the audit runs against
 * the reduced ceiling.
 *
 * It still recognizes a case id in a test title, because the TC-NNN shape is
 * common well outside any one methodology. What it cannot do is resolve that id
 * to a rule, which is exactly what the ceiling encodes: the suite is not judged
 * worse, it is judged with less evidence available.
 */

'use strict';

function detect() {
  return true;
}

function extract() {
  return {
    specsRoot: null,
    layout: 'generic',
    documents: 0,
    documentsExcluded: 0,
    rules: [],
    cases: [],
    risks: [],
    riskRegister: null,
    pendingTotal: 0,
    byDocument: [],
  };
}

module.exports = {
  name: 'generic',
  description: 'no rule inventory convention; audited against the reduced ceiling',
  caseIdPattern: /\bTC-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+\b|\bTC-\d+\b/i,
  detect,
  extract,
};
