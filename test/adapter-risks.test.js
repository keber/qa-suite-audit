/**
 * adapter-risks.test.js - Tests for the risk register reader.
 *
 * The register is a convention one project grew on its own; nothing in the
 * methodology defines it. These tests pin the two things that make reading it
 * safe: that only a real risk row declares a risk, and that adding a register
 * never moves the rule coverage figures people compare across months.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const risks          = require('../src/adapters/risks.js');
const adapter        = require('../src/adapters/qa-framework.js');
const { buildItems } = require('../src/traceability.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRepo(t, tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'risks-'));
  for (const [rel, contents] of Object.entries(tree)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, 'utf8');
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const SPEC_BASE = 'qa/01-specifications/module-ADM/submodule-CON';

const RULES_MD = [
  '# Reglas',
  '## RN-ADM-CON-001 -- Acceso',
  'Texto.',
  '## RN-ADM-CON-002 -- Cuenta',
  'Texto.',
].join('\n');

const SCENARIOS_MD = [
  '# Escenarios',
  '| ID | Titulo | Notas |',
  '|---|---|---|',
  '| TC-CON-001 | Acceso | RN-ADM-CON-001 |',
].join('\n');

/** A register shaped like the real one: risks, then constraints, then priorities. */
const RISKS_MD = [
  '# Riesgos y priorizacion de pruebas',
  '',
  '## 1. Riesgos detectados en la exploracion',
  '',
  '| ID | Sev | Riesgo | Evidencia | Modulo |',
  '|---|:---:|---|---|---|',
  '| R-01 | **ALTA** | **El umbral facial se revalida sobre un valor que el cliente declara.** Formalizado en `DEF-SIS-010` | `Service.cs:1195` | PECO |',
  '| R-02 | **ALTA** | **No existe autorizacion por operacion.** Todo operador puede invocar cualquier endpoint | `Filter.cs:31` | AUTH |',
  '| R-03 | MEDIA | **El extractor no tiene retry ni fallback.** Un 429 degrada en silencio | `Extractor.cs:80` | PECO |',
  '',
  '## 2. Restricciones del ambiente',
  '',
  '| ID | Riesgo | Efecto en las pruebas |',
  '|---|---|---|',
  '| C-02 | Techo del extractor | Impide pruebas de volumen |',
  '',
  '## 3. Prioridades',
  '',
  '| ID | Prueba | Por que |',
  '|---|---|---|',
  '| P0-1 | Enrolamiento de punta a punta | Prueba de que el ambiente es operable |',
].join('\n');

const WITH_REGISTER = {
  [`${SPEC_BASE}/01-business-rules.md`]: RULES_MD,
  [`${SPEC_BASE}/05-test-scenarios.md`]: SCENARIOS_MD,
  'qa/01-specifications/_risks.md': RISKS_MD,
};

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

test('only a row whose first cell is a risk id declares a risk', (t) => {
  // The register also holds constraints (C-NN) and priorities (P0-N), and risk
  // ids are quoted inside other risks' prose. The first-cell rule excludes all
  // of that without a list of exceptions.
  const root = makeRepo(t, WITH_REGISTER);
  const declared = adapter.extract(root).risks;

  assert.deepEqual(declared.map(r => r.id), ['R-01', 'R-02', 'R-03']);
});

test('a risk carries its severity, module and a readable title', (t) => {
  const root = makeRepo(t, WITH_REGISTER);
  const r1 = adapter.extract(root).risks[0];

  assert.equal(r1.severity, 'ALTA');
  assert.equal(r1.module, 'PECO');
  assert.equal(r1.title, 'El umbral facial se revalida sobre un valor que el cliente declara.');
  assert.match(r1.file, /_risks\.md$/);
  assert.ok(r1.line > 0);
});

test('a repository with no register reports none, and that is not an error', (t) => {
  const root = makeRepo(t, {
    [`${SPEC_BASE}/01-business-rules.md`]: RULES_MD,
    [`${SPEC_BASE}/05-test-scenarios.md`]: SCENARIOS_MD,
  });

  const specs = adapter.extract(root);
  assert.deepEqual(specs.risks, []);
  assert.equal(specs.riskRegister, null);
});

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

test('a risk cited in a header comment is found', (t) => {
  // This is the whole point of reading the raw file: every other scan in the
  // instrument masks comments away, and the citation lives in the comment that
  // explains why the test exists.
  const source = [
    '/**',
    ' * DEF-SIS-004 - resolved.',
    ' *',
    ' * Rule: R-05 (qa/01-specifications/_risks.md), restated in the defect file.',
    ' */',
    "import { test, expect } from '@playwright/test';",
    "test('[DEF-SIS-004] la persona anonimizada se rotula', async () => { expect(1).toBe(1); });",
  ].join('\n');

  assert.deepEqual(risks.referencedRisks(source), ['R-05']);
});

test('a file citing no risk yields none', (t) => {
  assert.deepEqual(risks.referencedRisks('const a = 1; // nothing here'), []);
});

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

test('a risk is covered when a test file cites it, and the item says that is inferential', (t) => {
  const root = makeRepo(t, WITH_REGISTER);
  const specs = adapter.extract(root);

  const items = buildItems(specs, new Set(), [
    { file: 'qa/07-automation/e2e/tests/db/def-sis-004.spec.ts', risks: ['R-02'] },
  ]);

  const cov = items['D5.risk-coverage'];
  assert.deepEqual(cov.covered, ['R-02']);
  assert.deepEqual(cov.uncovered, ['R-01', 'R-03']);
  assert.equal(cov.evidenceClass, 'inferential',
    'a file citing an id is not a test asserting a value');
});

test('adding a risk register does not move the rule coverage figures', (t) => {
  // Rules and risks answer different questions. Folding twenty risks into a
  // catalogue of rules would move a percentage people compare across months.
  const without = makeRepo(t, {
    [`${SPEC_BASE}/01-business-rules.md`]: RULES_MD,
    [`${SPEC_BASE}/05-test-scenarios.md`]: SCENARIOS_MD,
  });
  const with_ = makeRepo(t, WITH_REGISTER);

  const ids = new Set(['TC-CON-001']);
  const a = buildItems(adapter.extract(without), ids, []);
  const b = buildItems(adapter.extract(with_), ids, []);

  assert.deepEqual(a['D5.rule-catalogue'].count, b['D5.rule-catalogue'].count);
  assert.deepEqual(a['D5.covered-rules'], b['D5.covered-rules']);
  assert.deepEqual(a['D5.uncovered-rules'], b['D5.uncovered-rules']);
  assert.equal(b['D1.risk-inventory'].risks, 3, 'the risks are reported separately');
});

test('a repository with only a risk register still counts as having an inventory', (t) => {
  // Otherwise a project that writes down risks but not rules would be audited
  // as if it had nothing written down at all.
  const root = makeRepo(t, { 'qa/01-specifications/_risks.md': RISKS_MD });
  const items = buildItems(adapter.extract(root), new Set(), []);

  assert.equal(items['D1.rule-inventory'].rulesDeclared, 0);
  assert.equal(items['D1.rule-inventory'].present, true);
  assert.equal(items['D1.risk-inventory'].present, true);
});

test('risks are tallied by severity', (t) => {
  const root = makeRepo(t, WITH_REGISTER);
  const inv = buildItems(adapter.extract(root), new Set(), [])['D1.risk-inventory'];

  assert.deepEqual(inv.bySeverity, { ALTA: 2, MEDIA: 1 });
});
