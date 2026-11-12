/**
 * adapters/index.js - Traceability adapters
 *
 * Everything else in this instrument is methodology-free: it reads a runner
 * config, test source and pipeline definitions, none of which belong to any
 * particular way of organizing QA work.
 *
 * What IS methodology-specific is how a project writes down its business rules,
 * how it names a test case, and how a test is linked back to a rule. That is
 * the whole of the coupling, and it lives here.
 *
 * An adapter answers three things:
 *
 *   detect(repoRoot)     does this project follow the convention
 *   caseIdPattern        how a test title carries a case id
 *   extract(repoRoot)    the rule inventory and the case-to-rule linkage
 *
 * The generic adapter always matches, so there is no special case for
 * "no methodology detected". A project without a rule inventory is audited
 * against a lower ceiling, not treated as an error.
 */

'use strict';

const qaFramework = require('./qa-framework.js');
const generic     = require('./generic.js');

/** Ordered by specificity. The first adapter that detects wins. */
const ADAPTERS = [qaFramework, generic];

function selectAdapter(repoRoot) {
  for (const adapter of ADAPTERS) {
    if (adapter.detect(repoRoot)) return adapter;
  }
  return generic;
}

module.exports = { selectAdapter, ADAPTERS, qaFramework, generic };
