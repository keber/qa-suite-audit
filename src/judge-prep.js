#!/usr/bin/env node
/**
 * judge-prep.js - Bound the judgment before anyone judges
 *
 * Assembles the evidence for one repository and works out, per dimension, what
 * the evidence already settles and what is genuinely left to read. The agent
 * then answers only the open questions, inside bounds it cannot exceed.
 *
 * Why bound it at all
 * -------------------
 * An agent handed a rubric and a repository will produce seven numbers and a
 * paragraph each time, and those numbers will move between runs for reasons
 * nobody can trace. Every boundary a script can decide is a boundary the agent
 * must not be asked about. What remains is small, named, and citable.
 *
 * Caps and floors
 * ---------------
 * Evidence mostly RULES OUT high levels: fixed waits on every test rule out a
 * deterministic suite; no rule coverage rules out a specification-derived
 * oracle. It rarely proves a high level, because the top of every scale asks
 * about intent, and intent is not in the source. So thresholds mostly cap. A
 * floor is applied only where the level text is fully witnessed by evidence,
 * which in v1 is D6 alone.
 *
 * The verdict is bound to an evidence digest. Re-judging the same digest must
 * give the same answer; a different digest is a different audit.
 *
 * Usage:
 *   node judge-prep.js <repoPath> [--json] [--out <file>]
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { resolveSuite }      = require('./resolve-suite.js');
const { extractEvidence }   = require('./extract-source.js');
const { selectAdapter }     = require('./adapters/index.js');
const { buildItems }        = require('./traceability.js');
const { extractPipelines }  = require('./extract-pipelines.js');
const { extractMutationConfig } = require('./extract-mutation.js');
const { suiteTypeSignals }  = require('./suite-type.js');

const THRESHOLDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'thresholds.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Structural ceilings for v1 (repository evidence only)
// ---------------------------------------------------------------------------

const DIMENSIONS = [
  { n: 1, name: 'Oracle',        ceiling: 3, eliminatory: true  },
  { n: 2, name: 'Sensitivity',   ceiling: 3, eliminatory: true  },
  { n: 3, name: 'Determinism',   ceiling: 2, eliminatory: false },
  { n: 4, name: 'Diagnosis',     ceiling: 3, eliminatory: false },
  { n: 5, name: 'Rule coverage', ceiling: 2, eliminatory: false },
  { n: 6, name: 'Life in CI',    ceiling: 1, eliminatory: false },
  { n: 7, name: 'Maintainability', ceiling: 2, eliminatory: false },
];

const CEILING_REASON = {
  1: 'reachable only where a rule inventory exists in the repository',
  2: 'level 3 needs measured sensitivity: mutation config in the repository (capped at 2 without it) or a rule broken on purpose, which v1 cannot read',
  3: 'level 3 asserts behavior across runs, which the repository cannot witness',
  4: 'no structural limit in v1',
  5: 'level 3 needs the deliberate exclusions written down; v1 extracts no such statement',
  6: 'levels 2 and 3 assert merge and deploy gating, which lives in the CI server policy',
  7: 'level 3 needs review and retirement process evidence; v1 does not read history',
};

function threshold(id) {
  const t = THRESHOLDS.thresholds.find(x => x.id === id);
  if (!t) throw new Error(`unknown threshold: ${id}`);
  return t;
}

// ---------------------------------------------------------------------------
// Bounding
// ---------------------------------------------------------------------------

function boundDimensions(source, ruleItems, pipes) {
  const si = source.items;
  const ri = ruleItems;
  const pi = pipes.items;

  const hasInventory = ri['D1.rule-inventory'].present;
  const coveredRatio = ri['D5.covered-rules'].ratio ?? 0;

  const activeTests  = si['D2.assertless-tests'].of;
  const assertShare  = activeTests ? si['D2.assertless-tests'].count / activeTests : 0;
  const weakShare    = activeTests ? si['D2.weak-assertions'].weakOnlyTests / activeTests : 0;
  const mutationConfigs = si['D2.mutation-config'].count;
  const waitsPerTest = si['D3.fixed-waits'].perTest ?? 0;
  const semanticShare = si['D7.selector-mix'].semanticShare ?? 0;
  const runningPipes = pi['D6.suite-invocation'].pipelinesRunningTheSuite;

  const cfg  = source.suites[0]?.configEvidence ?? {};
  const hasArtifact = Boolean(cfg.trace || cfg.screenshot || cfg.video);

  const out = [];

  for (const d of DIMENSIONS) {
    const constraints = [];
    let ceiling = d.ceiling;
    let cap = d.ceiling;
    let floor = 0;

    if (d.n === 1) {
      if (!hasInventory) {
        ceiling = 1; cap = 1;
        constraints.push(note('D1.traceability-floor', 'no rule inventory in the repository', 'ceiling lowered to 1'));
      } else if (coveredRatio === 0) {
        cap = 1;
        constraints.push(note('D1.traceability-floor', `covered rules ratio ${fmt(coveredRatio)}`, 'capped at 1'));
      }
    }

    if (d.n === 2) {
      const t = threshold('D2.systemic-assertless');
      const systemic = assertShare >= t.value.assertlessShare || weakShare >= t.value.weakOnlyShare;
      if (systemic) {
        cap = 0;
        constraints.push(note(t.id,
          `assertless ${pct(assertShare)} (limit ${pct(t.value.assertlessShare)}), rendering-only ${pct(weakShare)} (limit ${pct(t.value.weakOnlyShare)})`,
          'capped at 0 - tests that cannot fail are a characteristic of this suite'));
      }

      // Both caps are recorded when both apply, and the lower one decides: the
      // 0 cap above must never be raised by this one. Config present only lifts
      // the cap. It does not prove the tool runs, so nothing here floors D2.
      const m = threshold('D2.sensitivity-measured');
      if (mutationConfigs <= m.value.mutationConfigCount) {
        cap = Math.min(cap, 2);
        constraints.push(note(m.id,
          'no mutation testing configuration found in the repository',
          'capped at 2 - level 3 needs measured sensitivity; a rule broken on purpose leaves no trace v1 reads'));
      }
    }

    if (d.n === 3) {
      const t = threshold('D3.waiting-as-strategy');
      if (waitsPerTest >= t.value.fixedWaitsPerTest) {
        cap = 1;
        constraints.push(note(t.id, `${waitsPerTest} fixed waits per test (limit ${t.value.fixedWaitsPerTest})`, 'capped at 1'));
      }
    }

    if (d.n === 4 && !hasArtifact) {
      cap = 1;
      constraints.push(note('D4.artifacts-present', 'no trace, screenshot or video configured', 'capped at 1'));
    }

    if (d.n === 5) {
      if (!hasInventory) {
        ceiling = 1; cap = 1;
        constraints.push(note('D5.coverage-floor', 'no rule inventory in the repository', 'ceiling lowered to 1'));
      } else if (coveredRatio === 0) {
        cap = 1;
        constraints.push(note('D5.coverage-floor', 'no declared rule is linked to an automated case', 'capped at 1'));
      }
    }

    if (d.n === 6) {
      const t = threshold('D6.runs-the-suite');
      const runs = runningPipes >= t.value.pipelinesRunningTheSuite;
      cap = runs ? 1 : 0;
      floor = runs ? 1 : 0;
      constraints.push(note(t.id,
        `${runningPipes} pipeline(s) both invoke the runner and point at the suite`,
        runs ? 'determined at 1' : 'determined at 0'));
    }

    if (d.n === 7) {
      const t = threshold('D7.selector-fragility');
      // A suite that queries nothing has no selector mix to be fragile. Capping
      // on a share computed from zero selectors would punish absent evidence,
      // which is the one thing these bounds exist to prevent.
      const hasSelectors = (si['D7.selector-mix'].semantic + si['D7.selector-mix'].testId + si['D7.selector-mix'].raw) > 0;
      if (hasSelectors && semanticShare < t.value.semanticSelectorShare) {
        cap = 1;
        constraints.push(note(t.id, `semantic selector share ${pct(semanticShare)} (limit ${pct(t.value.semanticSelectorShare)})`, 'capped at 1'));
      }
    }

    out.push({
      dimension: d.n,
      name: d.name,
      eliminatory: d.eliminatory,
      ceiling,
      ceilingReason: CEILING_REASON[d.n],
      bounds: { min: floor, max: cap },
      determined: floor === cap ? floor : null,
      constraints,
      mustCite: MUST_CITE[d.n],
      question: floor === cap ? null : QUESTION[d.n],
    });
  }

  return out;
}

function note(thresholdId, observed, effect) {
  const t = threshold(thresholdId);
  return { threshold: thresholdId, kind: t.kind, rule: t.rule, observed, effect };
}

/** Items an assigned level must cite. A level citing nothing else is invalid. */
const MUST_CITE = {
  1: ['D1.tc-id-coverage', 'D1.ext-id-coverage', 'D1.spec-linkage', 'D5.covered-rules', 'D1.risk-inventory'],
  2: ['D2.assertless-tests', 'D2.indirect-assertions', 'D2.weak-assertions', 'D2.skipped-tests', 'D2.expected-failures', 'D2.mutation-config'],
  3: ['D3.fixed-waits', 'D3.conditional-waits'],
  4: ['D4.failure-context'],
  5: ['D5.rule-catalogue', 'D5.covered-rules', 'D5.uncovered-rules', 'D5.orphan-tests', 'D5.risk-coverage'],
  6: ['D6.pipeline-present', 'D6.suite-invocation', 'D6.pipeline-triggers'],
  7: ['D7.selector-mix', 'D7.file-size'],
};

/** The one thing the evidence cannot settle, phrased so it has a readable answer. */
const QUESTION = {
  1: 'Read a sample of tests against the rules they cite. Do the expected values encode the rule, or does the test merely carry the rule id while asserting whatever the system returns?',
  2: 'Read the tests that assert only through helpers. Do those helpers contain a real check, and does each test fail for the behavior its title names?',
  3: 'Read the fixed waits and the retries setting in context. Are they load tolerance decisions the config explains, or flake suppression?',
  4: 'Read the test titles. Does a failure report name the business behavior that broke, or only the mechanism that was clicked?',
  5: 'Read the uncovered rules. Are they absent by decision or by oversight, and does anything in the repository say which?',
  6: null,
  7: 'Read the test names and the largest files. Do names describe behavior or implementation, and is duplication structural or incidental?',
};

function pct(n) { return `${Math.round(n * 1000) / 10}%`; }
function fmt(n)  { return Math.round(n * 1000) / 1000; }

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function prepare(repoRoot) {
  // The adapter is chosen first: it decides how a test title carries a case id,
  // which the source extractor needs before it reads a single file.
  const adapter  = selectAdapter(repoRoot);
  const boundary = resolveSuite(repoRoot);
  const extracted = extractEvidence(repoRoot, {
    caseIdPattern:  adapter.caseIdPattern,
    riskRefScanner: adapter.riskRefScanner,
  });
  // Mutation tooling is a repository-level fact, not a property of any one
  // suite, so it is read from the repository root and joins the source items
  // here, before the digest, rather than inside the per-suite extractor.
  const specs    = adapter.extract(repoRoot);
  // D0 reads the spec side only to say which case ids link to a declared rule,
  // so it joins here, after the adapter and still before the digest.
  // boundDimensions never reads it: a signal that moved a bound would be
  // issue #10, which is open on purpose.
  const source = {
    ...extracted,
    items: {
      ...extracted.items,
      ...extractMutationConfig(repoRoot),
      'D0.suite-type-signals': suiteTypeSignals(extracted, boundary, specs),
    },
  };
  const pipes    = extractPipelines(repoRoot);

  const automatedCaseIds = new Set(
    source.suites.flatMap(s => s.tests).map(t => t.caseId).filter(Boolean).map(id => id.toUpperCase())
  );
  const ruleItems = buildItems(specs, automatedCaseIds, source.riskReferences);

  // The adapter is part of the evidence: the same repository read through a
  // different convention is a different audit, and must not reuse a verdict.
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify([adapter.name, boundary, source, ruleItems, pipes]))
    .digest('hex');

  const dimensions = boundDimensions(source, ruleItems, pipes);
  const attainable = dimensions.reduce((n, d) => n + d.ceiling, 0);

  return {
    schema: 'judgment-input/v1',
    repo: boundary.repo,
    adapter: { name: adapter.name, description: adapter.description, specsRoot: specs.specsRoot },
    evidenceDigest: digest,
    attainable,
    maxPossibleGivenEvidence: dimensions.reduce((n, d) => n + d.bounds.max, 0),
    determinedDimensions: dimensions.filter(d => d.determined !== null).length,
    openQuestions: dimensions.filter(d => d.determined === null).length,
    dimensions,
    items: {
      source: source.items,
      rules: ruleItems,
      pipelines: pipes.items,
    },
    // Carried so a verdict can be validated on its own: an observation pointing
    // at a file that is not in the suite is a fabricated citation.
    suiteFiles: boundary.suites.flatMap(s => s.files).sort(),
  };
}

function printHuman(r) {
  console.log(`Repo: ${r.repo}`);
  console.log(`Evidence digest: ${r.evidenceDigest.slice(0, 16)}`);
  console.log(`Attainable in v1: ${r.attainable}/21   evidence allows at most: ${r.maxPossibleGivenEvidence}`);
  console.log(`Determined by evidence: ${r.determinedDimensions}/7   left to judgment: ${r.openQuestions}`);
  console.log('');

  for (const d of r.dimensions) {
    const range = d.determined !== null ? `= ${d.determined}` : `${d.bounds.min}..${d.bounds.max}`;
    const flag  = d.eliminatory ? ' [eliminatory]' : '';
    console.log(`  D${d.dimension} ${d.name.padEnd(16)} ${range.padEnd(8)} ceiling ${d.ceiling}${flag}`);
    for (const c of d.constraints) {
      console.log(`       ${c.kind === 'calibration' ? 'calibrated' : 'literal   '}  ${c.observed}`);
      console.log(`                   -> ${c.effect}`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const repoArg = args.find(a => !a.startsWith('--'));

  if (!repoArg) {
    console.error('Usage: node judge-prep.js <repoPath> [--json] [--out <file>]');
    process.exit(2);
  }

  const result = prepare(path.resolve(repoArg));
  const json   = JSON.stringify(result, null, 2);

  const outIdx = args.indexOf('--out');
  if (outIdx !== -1 && args[outIdx + 1]) {
    const target = path.resolve(args[outIdx + 1]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, json + '\n', 'utf8');
  }

  if (args.includes('--json')) console.log(json);
  else printHuman(result);
}

if (require.main === module) main();

module.exports = { prepare, boundDimensions, DIMENSIONS, THRESHOLDS };
