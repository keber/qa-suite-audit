/**
 * report/allure.js - Allure results renderer
 *
 * Writes an allure-results directory so an audit lands in the same dashboard
 * teams already read, and so the score gets a trend line across runs.
 *
 * The mapping is a choice, and a lossy one
 * ----------------------------------------
 * Allure has a binary status; the rubric has a 0 to 3 scale per dimension.
 * Anything mapped onto passed/failed loses the middle, so:
 *
 *   failed   level 0 - the dimension is absent, not merely weak
 *   passed   level 1 or above
 *   severity carries the part status cannot: blocker for an eliminatory zero,
 *            critical for any other zero, normal below ceiling, trivial at it
 *
 * Every result also carries the level, the ceiling and the reason for the
 * ceiling as parameters, because a green dimension sitting at 1 of 3 is not the
 * same thing as one at its ceiling and the dashboard would otherwise show them
 * identically.
 *
 * historyId is derived from repo and dimension, so Allure lines up the same
 * dimension across runs and the trend is real. uuid is derived from the
 * evidence digest, so re-rendering the same audit does not invent a new run.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { buildModel } = require('./model.js');

function id(...parts) {
  const hex = crypto.createHash('sha1').update(parts.join('|')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function statusOf(d) {
  return d.level === 0 ? 'failed' : 'passed';
}

function severityOf(d) {
  if (d.eliminatory && d.level === 0) return 'blocker';
  if (d.level === 0) return 'critical';
  if (d.level < d.ceiling) return 'normal';
  return 'trivial';
}

function messageOf(d) {
  if (d.level === 0 && d.eliminatory) {
    return `Eliminatory dimension scored 0. The suite does not pass regardless of its total.`;
  }
  if (d.level === 0) return 'Scored 0.';
  if (d.level < d.ceiling) return `Level ${d.level} of a reachable ${d.ceiling}.`;
  return `At its reachable ceiling of ${d.ceiling}.`;
}

function build(input, verdict, options = {}) {
  const m = buildModel(input, verdict);
  const start = options.timestamp ?? Date.now();
  const stop  = start;

  const containerUuid = id(m.digest, 'container');
  const files = [];

  const results = m.dimensions.map(d => {
    const uuid = id(m.digest, `D${d.n}`);

    const parameters = [
      { name: 'level',    value: String(d.level) },
      { name: 'ceiling',  value: String(d.ceiling) },
      { name: 'reachable by evidence', value: String(d.evidenceMax) },
      { name: 'confidence', value: String(d.confidence ?? 'unknown') },
      { name: 'decided by', value: d.determined !== null ? 'evidence' : (d.decidedByCalibration ? 'calibrated threshold' : 'judgment') },
    ];

    const links = d.citations.map(c => ({ name: c, url: '', type: 'evidence' }));

    const steps = d.constraints.map(c => ({
      name: `${c.kind === 'calibration' ? 'calibrated' : 'literal'}: ${c.observed}`,
      status: 'passed',
      stage: 'finished',
      start, stop,
      parameters: [{ name: 'effect', value: c.effect }],
      steps: [], attachments: [],
    }));

    if (d.observations.length) {
      steps.push({
        name: `read ${d.observations.length} location(s) in the suite`,
        status: 'passed', stage: 'finished', start, stop,
        parameters: d.observations.map((o, i) => ({ name: `observation ${i + 1}`, value: o })),
        steps: [], attachments: [],
      });
    }

    const result = {
      uuid,
      historyId: id(m.repo, `D${d.n}`),
      testCaseId: id(m.repo, `D${d.n}`),
      name: `D${d.n} ${d.name}`,
      fullName: `suite-audit.${m.repo}.D${d.n}-${d.name.replace(/\s+/g, '-').toLowerCase()}`,
      status: statusOf(d),
      statusDetails: { message: messageOf(d), trace: d.reasoning },
      description: [d.reasoning, '', `Ceiling ${d.ceiling}: ${d.ceilingReason}`].join('\n'),
      stage: 'finished',
      start, stop,
      labels: [
        { name: 'suite',    value: `Suite audit - ${m.repo}` },
        { name: 'parentSuite', value: 'qa-suite-audit' },
        { name: 'feature',  value: d.name },
        { name: 'severity', value: severityOf(d) },
        { name: 'tag',      value: d.eliminatory ? 'eliminatory' : 'scored' },
        ...(d.decidedByCalibration ? [{ name: 'tag', value: 'calibrated-threshold' }] : []),
        ...(d.confidence === 'low' ? [{ name: 'tag', value: 'low-confidence' }] : []),
      ],
      links,
      parameters,
      steps,
      attachments: [],
    };

    files.push({ name: `${uuid}-result.json`, body: JSON.stringify(result, null, 2) });
    return result;
  });

  const container = {
    uuid: containerUuid,
    name: `Suite audit - ${m.repo}`,
    children: results.map(r => r.uuid),
    befores: [], afters: [],
    start, stop,
  };
  files.push({ name: `${containerUuid}-container.json`, body: JSON.stringify(container, null, 2) });

  // Allure's binary status cannot express the scale, so the categories carry it.
  const categories = [
    { name: 'Eliminatory dimension at zero', matchedStatuses: ['failed'], messageRegex: '.*Eliminatory.*' },
    { name: 'Dimension absent', matchedStatuses: ['failed'] },
    { name: 'Below reachable ceiling', matchedStatuses: ['passed'], messageRegex: '.*of a reachable.*' },
  ];
  files.push({ name: 'categories.json', body: JSON.stringify(categories, null, 2) });

  const env = [
    `repo=${m.repo}`,
    `adapter=${m.adapter.name}`,
    `evidence.digest=${m.digest}`,
    `score=${m.obtained}/${m.attainable}`,
    `reachable.by.evidence=${m.evidenceMaximum}`,
    `eliminated=${m.eliminated}`,
    `source.rubric.bands.applied=false`,
    `scope=repository evidence only; no run history, no CI policy`,
  ].join('\n');
  files.push({ name: 'environment.properties', body: env + '\n' });

  return files;
}

function write(input, verdict, outDir, options = {}) {
  const files = build(input, verdict, options);
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(path.join(outDir, file.name), file.body, 'utf8');
  }
  return files.map(f => f.name);
}

module.exports = { build, write, statusOf, severityOf };
