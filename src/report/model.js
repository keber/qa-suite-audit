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
    thresholdObjections: verdict.thresholdObjections ?? [],
    notes: verdict.notes ?? '',
    risks: riskSummary(input),
    suiteFiles: (input.suiteFiles ?? []).length,
    items: input.items,
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
