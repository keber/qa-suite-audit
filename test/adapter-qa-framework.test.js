/**
 * adapter-qa-framework.test.js - Tests for the qa-framework traceability adapter.
 *
 * The adapter is the whole coupling between this instrument and one
 * methodology. It reads specification documents; it does not read test source,
 * and it does not compute coverage. The join lives in traceability.js so that
 * every adapter produces comparable numbers, so these tests feed the join a
 * plain list of automated case ids rather than a suite.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const adapter        = require('../src/adapters/qa-framework.js');
const generic        = require('../src/adapters/generic.js');
const { selectAdapter } = require('../src/adapters/index.js');
const { buildItems } = require('../src/traceability.js');

const { caseScopes, declaredInHeadings, findSpecsRoot, RULE_ID } = adapter;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(t, tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-'));
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
  '# Reglas de Negocio -- Contratos',
  '',
  '## RN-ADM-CON-001 -- Acceso al modulo',
  'El modulo es accesible para usuarios autenticados.',
  '',
  '## RN-ADM-CON-002 -- Seleccion de cuenta obligatoria',
  'Sin cuenta activa la tabla muestra un mensaje.',
  '',
  '## RN-ADM-CON-003 -- Regla sin test',
  'Nadie la automatizo.',
].join('\n');

const SCENARIOS_TABLE = [
  '# Escenarios de Prueba',
  '',
  '| ID | Titulo | Tipo | Origen | Notas |',
  '|---|---|---|---|---|',
  '| TC-CON-001 | Acceso sin cuenta | Funcional | UI-OBSERVED | RN-ADM-CON-002 |',
  '| TC-CON-002 | Listado de contratos | Funcional | UI-OBSERVED | RN-ADM-CON-001, FL-ADM-CON-001 |',
  '| TC-CON-003 | Columnas correctas | Funcional | UI-OBSERVED | |',
].join('\n');

const FULL_SPECS = {
  [`${SPEC_BASE}/01-business-rules.md`]: RULES_MD,
  [`${SPEC_BASE}/05-test-scenarios.md`]: SCENARIOS_TABLE,
};

/** Run the adapter and the shared join for a given set of automated case ids. */
function itemsFor(root, automatedCaseIds = []) {
  const specs = adapter.extract(root);
  return buildItems(specs, new Set(automatedCaseIds.map(id => id.toUpperCase())));
}

// ---------------------------------------------------------------------------
// Adapter selection
// ---------------------------------------------------------------------------

test('a repository with a specification tree selects the methodology adapter', (t) => {
  const root = makeRepo(t, FULL_SPECS);
  assert.equal(selectAdapter(root).name, 'qa-framework');
});

test('a repository without one falls back to the generic adapter', (t) => {
  // Not an error state. A project with no rule inventory is audited with less
  // evidence available, which the ceiling expresses.
  const root = makeRepo(t, { 'README.md': '# app' });
  assert.equal(selectAdapter(root).name, 'generic');
});

test('the generic adapter reports an empty inventory and still knows a case id shape', (t) => {
  const root = makeRepo(t, { 'README.md': '# app' });
  const specs = generic.extract(root);

  assert.deepEqual(specs.rules, []);
  assert.deepEqual(specs.cases, []);
  assert.ok(generic.caseIdPattern.test('[TC-CON-002] something'));
});

// ---------------------------------------------------------------------------
// Declaration versus mention
// ---------------------------------------------------------------------------

test('a rule is declared by its heading, not by being mentioned', (t) => {
  const lines = [
    '## RN-ADM-CON-001 -- Acceso',
    'This paragraph mentions RN-ADM-CON-999 without declaring it.',
    '## RN-ADM-CON-002 -- Cuenta',
  ];

  const declared = declaredInHeadings(lines, RULE_ID).map(d => d.id);
  assert.deepEqual(declared, ['RN-ADM-CON-001', 'RN-ADM-CON-002']);
  assert.ok(!declared.includes('RN-ADM-CON-999'),
    'a mention must not create a rule, or a suite could invent coverage');
});

test('a rule heading keeps its title without the id or separators', (t) => {
  const declared = declaredInHeadings(['## RN-ADM-CON-001 -- Acceso al modulo'], RULE_ID);
  assert.equal(declared[0].title, 'Acceso al modulo');
  assert.equal(declared[0].line, 1);
});

// ---------------------------------------------------------------------------
// Case scopes
// ---------------------------------------------------------------------------

test('a table row scopes a case to that row only', (t) => {
  const scopes = caseScopes(SCENARIOS_TABLE.split('\n'));
  const byId = Object.fromEntries(scopes.map(s => [s.id, s]));

  assert.equal(byId['TC-CON-001'].kind, 'table-row');
  assert.match(byId['TC-CON-001'].text, /RN-ADM-CON-002/);
  assert.ok(!/RN-ADM-CON-001/.test(byId['TC-CON-001'].text),
    'the neighbouring row must not leak into this scope');
});

test('a heading scopes a case until the next heading of the same level', (t) => {
  const lines = [
    '### TC-BK-001: First',
    'Body citing RN-BK-001.',
    '',
    '### TC-BK-002: Second',
    'Body citing RN-BK-002.',
  ];

  const scopes = caseScopes(lines);
  assert.equal(scopes.length, 2);
  assert.match(scopes[0].text, /RN-BK-001/);
  assert.ok(!/RN-BK-002/.test(scopes[0].text), 'the next case must not leak in');
});

test('a scenario document with no case ids yields no linkage rather than an error', (t) => {
  const scopes = caseScopes([
    '# Casos de Prueba Candidatos',
    'Lista de titulos, sin identificadores.',
    '- Registro de asistencia de entrada y salida',
  ]);
  assert.deepEqual(scopes, []);
});

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

test('coverage counts only rules cited by an automated case', (t) => {
  const root = makeRepo(t, FULL_SPECS);
  const items = itemsFor(root, ['TC-CON-001', 'TC-CON-002']);

  assert.equal(items['D5.rule-catalogue'].count, 3);
  assert.deepEqual(items['D5.covered-rules'].rules, ['FL-ADM-CON-001', 'RN-ADM-CON-001', 'RN-ADM-CON-002']);
  assert.deepEqual(items['D5.uncovered-rules'].rules, ['RN-ADM-CON-003'],
    'a rule nobody automated stays uncovered');
});

test('a declared case that is not automated does not cover its rules', (t) => {
  const root = makeRepo(t, FULL_SPECS);
  const items = itemsFor(root, ['TC-CON-001']);
  assert.deepEqual(items['D5.covered-rules'].rules, ['RN-ADM-CON-002']);
});

test('an automated case declared in no scenario document is an orphan', (t) => {
  const root = makeRepo(t, FULL_SPECS);
  const items = itemsFor(root, ['TC-CON-001', 'TC-GHOST-999']);
  assert.deepEqual(items['D5.orphan-tests'].cases, ['TC-GHOST-999']);
});

test('a suite with no case ids covers nothing, whatever the specs say', (t) => {
  const root = makeRepo(t, FULL_SPECS);
  const items = itemsFor(root, []);

  assert.equal(items['D1.rule-inventory'].rulesDeclared, 3, 'the rules are still catalogued');
  assert.equal(items['D5.covered-rules'].count, 0, 'but the chain is cut at the last link');
});

// ---------------------------------------------------------------------------
// Specification boundary
// ---------------------------------------------------------------------------

test('a tracker cache under the specification root is not a specification', (t) => {
  // One repository keeps 747 cached tracker items under 01-specifications.
  // Counting them inflates the inventory the way node_modules inflated tests.
  const root = makeRepo(t, {
    ...FULL_SPECS,
    'qa/01-specifications/source/ado-workitems-cache/wi-1.md': '## RN-FAKE-001 -- not a spec',
    'qa/01-specifications/source/ado-workitems-cache/wi-2.md': '## RN-FAKE-002 -- not a spec',
  });

  const inv = itemsFor(root, [])['D1.rule-inventory'];

  assert.equal(inv.layout, 'framework');
  assert.equal(inv.documents, 2, 'only the two module/submodule documents count');
  assert.equal(inv.documentsExcluded, 2);
  assert.equal(inv.rulesDeclared, 3, 'the cached RN-FAKE ids are not rules');
});

test('findSpecsRoot returns null when no specification tree exists', (t) => {
  const root = makeRepo(t, { 'README.md': '# app' });
  assert.equal(findSpecsRoot(root), null);
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test('unconfirmed information is counted, never silently accepted', (t) => {
  const root = makeRepo(t, {
    ...FULL_SPECS,
    [`${SPEC_BASE}/01-business-rules.md`]: RULES_MD + '\n\n## RN-ADM-CON-004 -- Dudosa\nError message: PENDING-CODE\n',
  });

  assert.equal(itemsFor(root, [])['D5.pending-markers'].count, 1);
});

test('the adapter emits no rubric level or score', (t) => {
  const root = makeRepo(t, FULL_SPECS);
  const json = JSON.stringify(itemsFor(root, ['TC-CON-001']));

  for (const forbidden of ['"level"', '"score"', '"verdict"', '"rating"']) {
    assert.ok(!json.includes(forbidden), `evidence must not contain ${forbidden}`);
  }
});

test('two extractions of the same specifications are identical', (t) => {
  const root = makeRepo(t, FULL_SPECS);
  assert.equal(
    JSON.stringify(itemsFor(root, ['TC-CON-001'])),
    JSON.stringify(itemsFor(root, ['TC-CON-001']))
  );
});
