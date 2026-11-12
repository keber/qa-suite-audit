/**
 * report/model.js - One view model, three renderers
 *
 * Every renderer answers the same questions, so they compute nothing of their
 * own. A number that appears in the terminal, in the HTML page and in Allure
 * has to be the same number, and the only way to guarantee that is for it to be
 * computed once.
 *
 * The model carries the gaps as first-class facts, not as something a reader
 * has to derive: how far each dimension is from its ceiling, why the ceiling is
 * where it is, and which decisions were made by a calibrated threshold rather
 * than by the rubric text.
 */

'use strict';

function buildModel(input, verdict) {
  const byDimension = new Map(verdict.levels.map(l => [l.dimension, l]));

  const dimensions = input.dimensions.map(d => {
    const assigned = byDimension.get(d.dimension) ?? {};
    const level = Number.isInteger(assigned.level) ? assigned.level : null;

    const calibrated = d.constraints.filter(c => c.kind === 'calibration');

    return {
      n: d.dimension,
      name: d.name,
      eliminatory: d.eliminatory,
      level,
      ceiling: d.ceiling,
      ceilingReason: d.ceilingReason,
      evidenceMax: d.bounds.max,
      determined: d.determined,
      gapToCeiling: level === null ? null : d.ceiling - level,
      cappedByEvidence: d.bounds.max < d.ceiling,
      confidence: assigned.confidence ?? null,
      citations: assigned.citations ?? [],
      observations: assigned.observations ?? [],
      reasoning: assigned.reasoning ?? '',
      constraints: d.constraints,
      decidedByCalibration: calibrated.length > 0,
      question: d.question,
    };
  });

  const calibratedDecisions = dimensions
    .filter(d => d.decidedByCalibration)
    .map(d => ({
      dimension: d.n,
      name: d.name,
      constraints: d.constraints.filter(c => c.kind === 'calibration'),
    }));

  return {
    repo: input.repo,
    adapter: input.adapter ?? { name: 'unknown' },
    // Declared by the judge and shown as declared. It is context for reading the
    // dimensions below, not an input to any of them: nothing here is computed
    // from it.
    suiteType: suiteTypeSummary(verdict.suiteType),
    digest: input.evidenceDigest,
    shortDigest: String(input.evidenceDigest).slice(0, 12),
    obtained: verdict.obtained,
    attainable: verdict.attainable,
    evidenceMaximum: dimensions.reduce((n, d) => n + d.evidenceMax, 0),
    eliminated: verdict.eliminated === true,
    eliminatedBy: verdict.eliminatedBy ?? [],
    lowConfidence: dimensions.filter(d => d.confidence === 'low').map(d => d.n),
    dimensions,
    calibratedDecisions,
    // Derived by judge-prep, not evidence: from the bounds, and for the
    // variable filters from D6.run-scope. An input written before they existed
    // simply has none.
    teamQuestionsHeading: TEAM_QUESTIONS_HEADING,
    teamQuestionsNote: TEAM_QUESTIONS_NOTE,
    teamQuestions: teamQuestionList(input.teamQuestions),
    thresholdObjections: verdict.thresholdObjections ?? [],
    notes: verdict.notes ?? '',
    risks: riskSummary(input),
    suiteFiles: (input.suiteFiles ?? []).length,
    items: input.items,
  };
}

const TEAM_QUESTIONS_HEADING = 'Questions for the team';

// One statement of what an answer is worth, shown by every renderer so none of
// them can promise more than the tool does. Only a rule inventory and a
// mutation config are read by this release; no other answer moves a bound.
const TEAM_QUESTIONS_NOTE =
  'Questions marked read by this release lift their bound once the answer is committed to the repository ' +
  'and the evidence is extracted again. The others are for the reader of this report: they record what a ' +
  'future extractor would need, and the bound stays where it is.';

/**
 * The questions as every renderer shows them. The input may predate this field
 * or be hand edited, so nothing is trusted: a non-array is no questions, an
 * entry that is not a well formed object is dropped, and the dimension is
 * coerced to an integer so it never carries markup or terminal sequences.
 */
function teamQuestionList(raw) {
  if (!Array.isArray(raw)) return [];

  const out = [];
  for (const q of raw) {
    if (q === null || typeof q !== 'object' || Array.isArray(q)) continue;
    if (typeof q.id !== 'string' || typeof q.question !== 'string') continue;

    const dimension = typeof q.dimension === 'number' || typeof q.dimension === 'string' ? Number(q.dimension) : NaN;
    if (!Number.isInteger(dimension)) continue;

    const unlocks = Number.isInteger(q.unlocks) ? q.unlocks : null;
    const read = q.readByThisRelease === true;

    out.push({
      id: q.id,
      dimension,
      source: String(q.source ?? ''),
      question: q.question,
      reason: typeof q.reason === 'string' ? q.reason : '',
      unlocks,
      readByThisRelease: read,
      status: read ? 'read by this release' : 'for the reader',
      effect: effectOf(read, unlocks),
    });
  }
  return out;
}

function effectOf(read, unlocks) {
  if (read && unlocks !== null) {
    return `lifts the bound to level ${unlocks} once the answer is committed to the repository and the evidence is extracted again`;
  }
  if (unlocks !== null) {
    return `the bound stays; an answer records what a future extractor would need (level ${unlocks} would then be allowed)`;
  }
  return 'informs only; it lifts no bound';
}

/** The declared suite type with its breakdown sorted, so every renderer lists it alike. */
function suiteTypeSummary(st) {
  if (!st || typeof st.type !== 'string') return null;

  return {
    type: st.type,
    byDirectory: Object.entries(st.byDirectory ?? {})
      .map(([directory, type]) => ({ directory, type }))
      .sort((a, b) => a.directory.localeCompare(b.directory)),
  };
}

/**
 * The risk register, when the repository keeps one.
 *
 * Reported next to the score rather than folded into it. Risk coverage is
 * inferential - a file citing an id, not a test asserting a value - so it
 * informs a reader without moving a number.
 */
function riskSummary(input) {
  const inv = input.items?.rules?.['D1.risk-inventory'];
  const cov = input.items?.rules?.['D5.risk-coverage'];
  if (!inv || !inv.present) return null;

  return {
    register: inv.register,
    total: inv.risks,
    bySeverity: inv.bySeverity ?? {},
    covered: cov?.count ?? 0,
    uncovered: cov?.uncovered ?? [],
    citingFiles: cov?.citingFiles ?? [],
    evidenceClass: cov?.evidenceClass ?? 'inferential',
  };
}

module.exports = { buildModel };
