/**
 * extract-source.test.js - Tests for the source evidence extractor.
 *
 * The extractor answers questions a file-level count cannot: which tests carry
 * no assertion, which assert only that something rendered, which skip at
 * runtime. Those per-test attributions are what rubric levels cite, so an
 * extractor that miscounts produces a defensible-looking score built on sand.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const {
  extractEvidence,
  countSerialDeclarations,
  extractFile,
  findTests,
  maskSource,
  aggregate,
} = require('../src/extract-source.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(t, tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-evidence-'));
  for (const [rel, contents] of Object.entries(tree)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, 'utf8');
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const CONFIG = [
  "import { defineConfig } from '@playwright/test';",
  'export default defineConfig({',
  "  testDir: './tests',",
  '  retries: process.env.CI ? 2 : 1,',
  '  workers: 1,',
  '  fullyParallel: false,',
  '  reporter: [',
  "    ['html', { open: 'never' }],",
  "    ['list'],",
  "    ['@alex_neo/playwright-azure-reporter', adoConfig],",
  '  ],',
  '  use: {',
  "    trace: 'retain-on-failure',",
  "    screenshot: 'only-on-failure',",
  "    video: 'retain-on-failure',",
  '  },',
  '});',
].join('\n');

/** Extract one synthetic file and return its per-test records. */
function recordsFor(t, source) {
  const root = makeRepo(t, { 'playwright.config.ts': CONFIG, 'tests/a.spec.ts': source });
  return extractFile(root, 'tests/a.spec.ts');
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

test('maskSource preserves every offset and newline', (t) => {
  const src = "const a = 'hello';\n// comment\nconst b = 1;";
  const masked = maskSource(src);
  assert.equal(masked.length, src.length);
  assert.equal(masked.split('\n').length, src.split('\n').length);
});

test('a signal inside a string literal is not counted as code', (t) => {
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test('[TC-A-001] real', async ({ page }) => {",
    "  await page.click('#go');",
    "  console.log('call expect( and waitForTimeout( in a message');",
    '  await expect(page.locator("#total")).toHaveText("42");',
    '});',
  ].join('\n'));

  assert.equal(records.length, 1);
  assert.equal(records[0].assertions, 1, 'the literal mention must not count');
  assert.equal(records[0].fixedWaits, 0);
});

// ---------------------------------------------------------------------------
// Test discovery
// ---------------------------------------------------------------------------

test('a conditional skip in a body is not a skipped test declaration', (t) => {
  // test.skip(condition, 'reason') inside a body means the test may not run.
  // Counting it as a declaration invents a test and a skip that do not exist.
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test('[TC-A-001] runs sometimes', async ({ page, browserName }) => {",
    "  test.skip(browserName === 'firefox', 'not supported');",
    '  await expect(page).toHaveTitle("x");',
    '});',
  ].join('\n'));

  assert.equal(records.length, 1, 'exactly one test');
  assert.equal(records[0].skipped, false, 'the declaration is not skipped');
  assert.equal(records[0].conditionalSkips, 1, 'the runtime skip is tracked separately');
});

test('a skipped declaration is counted as skipped', (t) => {
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test.skip('[TC-A-001] parked', async ({ page }) => {",
    '  await expect(page).toHaveTitle("x");',
    '});',
  ].join('\n'));

  assert.equal(records.length, 1);
  assert.equal(records[0].skipped, true);
  assert.equal(records[0].conditionalSkips, 0);
});

test('a skipped describe marks every test inside it as skipped', (t) => {
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test.describe.skip('parked group', () => {",
    "  test('[TC-A-001] one', async ({ page }) => { await expect(page).toHaveTitle('x'); });",
    "  test('[TC-A-002] two', async ({ page }) => { await expect(page).toHaveTitle('y'); });",
    '});',
  ].join('\n'));

  assert.equal(records.length, 2);
  assert.ok(records.every(r => r.skipped), 'skip propagates from the group');
  assert.ok(records.every(r => r.group === 'parked group'));
});

test('test.step is counted as failure context, never as a test', (t) => {
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test('[TC-A-001] with steps', async ({ page }) => {",
    "  await test.step('open the form', async () => { await page.click('#a'); });",
    "  await test.step('submit', async () => { await expect(page).toHaveTitle('x'); });",
    '});',
  ].join('\n'));

  assert.equal(records.length, 1);
  assert.equal(records[0].steps, 2);
});

// ---------------------------------------------------------------------------
// Title metadata
// ---------------------------------------------------------------------------

test('case ids with letter segments are recognized', (t) => {
  // A pattern requiring a digit straight after "TC-" reports zero coverage on
  // a fully traced suite, because real ids look like TC-CON-002.
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test('[27499][TC-CON-002][P0] does a thing', async ({ page }) => {",
    '  await expect(page).toHaveTitle("x");',
    '});',
    "test('[TC-PP-GRP-004] another @P1', async ({ page }) => {",
    '  await expect(page).toHaveTitle("y");',
    '});',
  ].join('\n'));

  assert.equal(records[0].caseId, 'TC-CON-002');
  assert.equal(records[0].externalId, '27499');
  assert.equal(records[0].priority, 'P0');

  assert.equal(records[1].caseId, 'TC-PP-GRP-004');
  assert.equal(records[1].externalId, null, 'no external id present');
  assert.equal(records[1].priority, 'P1');
});

test('an external work item id is never reported as a case id', (t) => {
  // An external id points at a ticket, not at a rule. Conflating the two makes
  // a suite traced only to task management look traced to acceptance criteria.
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test('[22994] 4.1 Registro de asistencia', async ({ page }) => {",
    '  await expect(page).toHaveTitle("x");',
    '});',
  ].join('\n'));

  assert.equal(records[0].externalId, '22994');
  assert.equal(records[0].caseId, null);
});

// ---------------------------------------------------------------------------
// Sensitivity signals
// ---------------------------------------------------------------------------

test('a test with no assertion is attributed by file and line', (t) => {
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test('[TC-A-001] asserts', async ({ page }) => {",
    '  await expect(page).toHaveTitle("x");',
    '});',
    "test('[TC-A-002] cannot fail', async ({ page }) => {",
    "  await page.goto('/');",
    "  await page.click('#go');",
    '});',
  ].join('\n'));

  const items = aggregate(records);
  assert.equal(items['D2.assertless-tests'].count, 1);
  assert.equal(items['D2.assertless-tests'].tests.length, 1);
  assert.match(items['D2.assertless-tests'].tests[0], /tests\/a\.spec\.ts:5$/);
});

test('a skipped test is excluded from the assertless population', (t) => {
  // A skipped test cannot fail for a different reason, and counting it as
  // assertless double punishes the same fact already recorded as a skip.
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test.skip('[TC-A-001] parked and empty', async ({ page }) => {",
    "  await page.goto('/');",
    '});',
  ].join('\n'));

  const items = aggregate(records);
  assert.equal(items['D2.assertless-tests'].count, 0);
  assert.equal(items['D2.assertless-tests'].of, 0);
  assert.equal(items['D2.skipped-tests'].count, 1);
});

test('an assertion behind a page object is not reported as assertless', (t) => {
  // Found against a real suite: tests calling bkIng.verifyValidationMessage()
  // were reported as unable to fail. The assertion lives in the page object,
  // and layering it there is the structure D7 rewards - so the naive count
  // accused the best-structured suite of the worst defect.
  const records = recordsFor(t, [
    "import { test } from '@playwright/test';",
    "import { BKIngPage } from '../pages/bk-ing.page';",
    "test('[TC-BK-ING-007] Validacion - Tipo de Transporte vacio @P0', async ({ page }) => {",
    '  const bkIng = new BKIngPage(page);',
    '  await bkIng.open();',
    '  await bkIng.clickGuardar();',
    "  await bkIng.verifyValidationMessage('El tipo de transporte es requerido');",
    '});',
  ].join('\n'));

  const items = aggregate(records);
  assert.equal(records[0].assertions, 0, 'no direct assertion is present');
  assert.equal(records[0].assertionProxies, 1);
  assert.equal(items['D2.assertless-tests'].count, 0, 'the proxy rescues it');
  assert.equal(items['D2.indirect-assertions'].count, 1, 'but the indirection is surfaced');
  assert.equal(items['D2.indirect-assertions'].evidenceClass, 'inferential',
    'the helper still has to contain a real check, which this cannot prove');
});

test('a test marked as an expected failure is surfaced', (t) => {
  // test.fail() parks a known defect: the runner reports a PASSING test as a
  // failure, so the test cannot go red for the behavior it names.
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test('[TC-ML-NAVE-004] Crear registro valido @P0', async ({ page }) => {",
    "  test.fail(true, 'DEF-SIS-004: app requires a field the spec marks optional');",
    '  await expect(page).toHaveTitle("x");',
    '});',
  ].join('\n'));

  const items = aggregate(records);
  assert.equal(records[0].expectedFailures, 1);
  assert.equal(items['D2.expected-failures'].count, 1);
  assert.equal(records[0].skipped, false, 'an expected failure is not a skip');
});

test('tests whose only assertions witness rendering are flagged', (t) => {
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test('[TC-A-001] renders only', async ({ page }) => {",
    "  await expect(page.locator('#grid')).toBeVisible();",
    '});',
    "test('[TC-A-002] checks a value', async ({ page }) => {",
    "  await expect(page.locator('#total')).toHaveText('42');",
    '});',
  ].join('\n'));

  const items = aggregate(records);
  assert.equal(items['D2.weak-assertions'].weakOnlyTests, 1);
  assert.match(items['D2.weak-assertions'].tests[0], /:2$/);
});

// ---------------------------------------------------------------------------
// Determinism and maintainability signals
// ---------------------------------------------------------------------------

test('fixed waits are separated from conditional waits', (t) => {
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test('[TC-A-001] waits', async ({ page }) => {",
    '  await page.waitForTimeout(2000);',
    "  await page.waitForSelector('#grid');",
    "  await page.waitForLoadState('networkidle');",
    '  await expect(page).toHaveTitle("x");',
    '});',
  ].join('\n'));

  assert.equal(records[0].fixedWaits, 1);
  assert.equal(records[0].conditionalWaits, 2);
});

test('selectors are classified as semantic, test id or raw', (t) => {
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test('[TC-A-001] selects', async ({ page }) => {",
    "  await page.getByRole('button', { name: 'Save' }).click();",
    "  await page.getByLabel('Name').fill('x');",
    "  await page.getByTestId('grid').click();",
    "  await page.locator('#raw-css').click();",
    '  await expect(page).toHaveTitle("x");',
    '});',
  ].join('\n'));

  assert.equal(records[0].selectors.semantic, 2);
  assert.equal(records[0].selectors.testId, 1);
  assert.equal(records[0].selectors.raw, 1);

  const mix = aggregate(records)['D7.selector-mix'];
  assert.equal(mix.semanticShare, 0.75);
});

// ---------------------------------------------------------------------------
// Config evidence
// ---------------------------------------------------------------------------

test('config evidence reads expressions, the use block and reporter names', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': CONFIG,
    'tests/a.spec.ts': "import { test, expect } from '@playwright/test';\ntest('[TC-A-001] x', async ({ page }) => { await expect(page).toHaveTitle('x'); });\n",
  });

  const cfg = extractEvidence(root).suites[0].configEvidence;

  assert.equal(cfg.retries, 'process.env.CI ? 2 : 1', 'a ternary is reported verbatim, not guessed');
  assert.equal(cfg.workers, '1');
  assert.equal(cfg.fullyParallel, 'false');
  assert.equal(cfg.trace, 'retain-on-failure');
  assert.equal(cfg.screenshot, 'only-on-failure');
  assert.equal(cfg.video, 'retain-on-failure');
});

test('reporter option values are not reported as reporters', (t) => {
  // A reporter entry is ['name', { options }]. Scanning every string in the
  // block also returns 'never' and 'playwright-report' as if they were reporters.
  const root = makeRepo(t, {
    'playwright.config.ts': CONFIG,
    'tests/a.spec.ts': "import { test, expect } from '@playwright/test';\ntest('[TC-A-001] x', async ({ page }) => { await expect(page).toHaveTitle('x'); });\n",
  });

  const cfg = extractEvidence(root).suites[0].configEvidence;
  assert.deepEqual(cfg.reporters, ['html', 'list', '@alex_neo/playwright-azure-reporter']);
  assert.ok(!cfg.reporters.includes('never'), 'an option value is not a reporter');
});

// ---------------------------------------------------------------------------
// Reproducibility
// ---------------------------------------------------------------------------

test('two extractions over identical input produce identical output', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': CONFIG,
    'tests/b.spec.ts': "import { test, expect } from '@playwright/test';\ntest('[TC-B-001] b', async ({ page }) => { await expect(page).toHaveTitle('b'); });\n",
    'tests/a.spec.ts': "import { test, expect } from '@playwright/test';\ntest('[TC-A-001] a', async ({ page }) => { await expect(page).toHaveTitle('a'); });\n",
  });

  const first  = JSON.stringify(extractEvidence(root), null, 2);
  const second = JSON.stringify(extractEvidence(root), null, 2);
  assert.equal(first, second);
});

test('evidence output carries no absolute path and no timestamp', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': CONFIG,
    'tests/a.spec.ts': "import { test, expect } from '@playwright/test';\ntest('[TC-A-001] a', async ({ page }) => { await expect(page).toHaveTitle('a'); });\n",
  });

  const json = JSON.stringify(extractEvidence(root));
  assert.ok(!json.includes(root.replace(/\\/g, '\\\\')));
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(json));
});

test('the extractor produces no rubric level or score', (t) => {
  // Scripts produce evidence; levels are assigned by an agent citing item ids.
  // A score emitted here would be a judgment nobody can trace to evidence.
  const root = makeRepo(t, {
    'playwright.config.ts': CONFIG,
    'tests/a.spec.ts': "import { test, expect } from '@playwright/test';\ntest('[TC-A-001] a', async ({ page }) => { await expect(page).toHaveTitle('a'); });\n",
  });

  const json = JSON.stringify(extractEvidence(root));
  for (const forbidden of ['"level"', '"score"', '"verdict"', '"rating"']) {
    assert.ok(!json.includes(forbidden), `evidence must not contain ${forbidden}`);
  }
});

test('a local assertion helper is an assertion proxy too', (t) => {
  // The first version of this only matched method calls with a leading dot, so
  // a suite using free helper functions - expectCollapsibleRowHasAddButton(...)
  // rather than page.verifyX(...) - was still reported as unable to fail.
  const records = recordsFor(t, [
    "import { test } from '@playwright/test';",
    "import { expectCollapsibleRowHasAddButton } from './helpers';",
    "test('[TC-LIB-033] Variedad permite multi-seleccion', async ({ page }) => {",
    "  await openEditDrawer(page);",
    "  await expectCollapsibleRowHasAddButton(page, page.locator('.wrapper'), 'TC-LIB-033');",
    '});',
  ].join('\n'));

  const items = aggregate(records);
  assert.equal(records[0].assertionProxies, 1);
  assert.equal(items['D2.assertless-tests'].count, 0);
  assert.equal(items['D2.indirect-assertions'].count, 1);
});

test('a bare expect call is a direct assertion, not a proxy', (t) => {
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test('[TC-A-001] direct', async ({ page }) => {",
    "  await expect(page.locator('#total')).toHaveText('42');",
    '});',
  ].join('\n'));

  assert.equal(records[0].assertions, 1);
  assert.equal(records[0].assertionProxies, 0, 'expect( has no capital after the prefix');
});

test('a body skip with a literal true is a skipped test, not an assertless one', (t) => {
  // Found against a real suite: a security-control case parked with
  // test.skip(true, REASON) and the reason on record. Reading the literal as a
  // condition left the test counted as active, and because its body never
  // reaches an assertion it then surfaced as a test that cannot fail. It is the
  // opposite - a documented decision not to run it.
  const records = recordsFor(t, [
    "import { test } from '@playwright/test';",
    "test('[DEF-SIS-016] el servidor rechaza una operacion no permitida @P0', async () => {",
    "  test.skip(true, 'NO AUTOMATIZABLE: routed to the formal security process');",
    '});',
  ].join('\n'));

  const items = aggregate(records);
  assert.equal(records[0].skipped, true);
  assert.equal(items['D2.assertless-tests'].count, 0, 'a parked test is not a test that cannot fail');
  assert.equal(items['D2.skipped-tests'].count, 1);
});

test('a body skip with a real condition stays conditional', (t) => {
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test('[TC-A-001] runs sometimes', async ({ page, browserName }) => {",
    "  test.skip(browserName === 'firefox', 'not supported');",
    '  await expect(page).toHaveTitle("x");',
    '});',
  ].join('\n'));

  assert.equal(records[0].skipped, false);
  assert.equal(records[0].conditionalSkips, 1);
});

test('a test declared with test.fail is discovered and marked as an expected failure', (t) => {
  // Found while chasing a coverage drop: test.fail was missing from the
  // declaration pattern, so an entire family of tests was invisible. Those
  // tests carry case ids, so their rules silently showed as uncovered.
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test.fail('[TC-IPR-004] Boton Ver HTML abre modal', async ({ page }) => {",
    "  await expect(page.locator('#modal')).toHaveText('Visualizar informe');",
    '});',
  ].join('\n'));

  assert.equal(records.length, 1, 'the test exists');
  assert.equal(records[0].caseId, 'TC-IPR-004', 'and its case id is readable');
  assert.equal(records[0].skipped, false, 'an expected failure is not a skip');
  assert.equal(aggregate(records)['D2.expected-failures'].count, 1);
});

test('a test declared with test.slow is an ordinary test', (t) => {
  const records = recordsFor(t, [
    "import { test, expect } from '@playwright/test';",
    "test.slow('[TC-A-001] takes a while', async ({ page }) => {",
    "  await expect(page).toHaveTitle('x');",
    '});',
  ].join('\n'));

  assert.equal(records.length, 1);
  assert.equal(records[0].skipped, false);
  assert.equal(aggregate(records)['D2.expected-failures'].count, 0);
});

// ---------------------------------------------------------------------------
// Config items: named, citable, one entry per suite
// ---------------------------------------------------------------------------

const SPEC_OK = "import { test, expect } from '@playwright/test';\ntest('[TC-A-001] x', async ({ page }) => { await expect(page).toHaveTitle('x'); });\n";

test('the five config items are emitted per suite, keyed by suite id', (t) => {
  const root = makeRepo(t, { 'playwright.config.ts': CONFIG, 'tests/a.spec.ts': SPEC_OK });

  const result = extractEvidence(root);
  const suiteId = result.suites[0].id;

  for (const id of ['D3.retries-config', 'D3.serial-mode', 'D4.reporter-config', 'D4.trace-config', 'D4.artifact-retention']) {
    assert.ok(result.items[id], id + ' must be a citable item');
    assert.ok(result.items[id].bySuite[suiteId], id + ' must be keyed by the suite id');
  }

  const items = result.items;
  assert.equal(items['D3.retries-config'].bySuite[suiteId].retries, 'process.env.CI ? 2 : 1');
  assert.equal(items['D3.serial-mode'].bySuite[suiteId].fullyParallel, 'false');
  assert.equal(items['D3.serial-mode'].bySuite[suiteId].workers, '1');
  assert.equal(items['D4.trace-config'].bySuite[suiteId].trace, 'retain-on-failure');
  assert.deepEqual(items['D4.reporter-config'].bySuite[suiteId].reporters, ['html', 'list', '@alex_neo/playwright-azure-reporter']);
});

test('artifact retention reads outputDir from the config and reports null when absent', (t) => {
  const withDir = makeRepo(t, {
    'playwright.config.ts': "import { defineConfig } from '@playwright/test';\nexport default defineConfig({\n  testDir: './tests',\n  outputDir: 'test-results',\n});\n",
    'tests/a.spec.ts': SPEC_OK,
  });
  const without = makeRepo(t, {
    'playwright.config.ts': "import { defineConfig } from '@playwright/test';\nexport default defineConfig({\n  testDir: './tests',\n});\n",
    'tests/a.spec.ts': SPEC_OK,
  });

  const a = extractEvidence(withDir);
  const b = extractEvidence(without);
  assert.equal(a.items['D4.artifact-retention'].bySuite[a.suites[0].id].outputDir, 'test-results');
  assert.equal(b.items['D4.artifact-retention'].bySuite[b.suites[0].id].outputDir, null);
});

test('serial declarations are counted from code, not from strings or comments', () => {
  const src = [
    "import { test } from '@playwright/test';",
    "test.describe.serial('flow', () => { test('a', async () => {}); });",
    "test.describe.configure({ mode: 'serial' });",
    "test.describe.configure({ mode: 'parallel' });",
    "// test.describe.serial('commented out', () => {});",
    "const s = \"test.describe.serial('in a string', () => {})\";",
  ].join('\n');

  assert.deepEqual(countSerialDeclarations(src), { describeSerial: 1, configuredSerial: 1 });
});

test('serial usage is aggregated across the files of a suite', (t) => {
  const serial = "import { test } from '@playwright/test';\ntest.describe.serial('flow', () => { test('a', async () => {}); });\n";
  const root = makeRepo(t, {
    'playwright.config.ts': CONFIG,
    'tests/a.spec.ts': serial,
    'tests/b.spec.ts': serial,
  });

  const r = extractEvidence(root);
  assert.equal(r.items['D3.serial-mode'].bySuite[r.suites[0].id].describeSerial, 2);
});

// ---------------------------------------------------------------------------
// D5.negative-tests
// ---------------------------------------------------------------------------

/** One-assertion test with the given title and body, for signal probes. */
function probe(title, body = "await expect(page.locator('#a')).toHaveText('1');") {
  return `test(${JSON.stringify(title)}, async ({ page }) => { ${body} });`;
}

const PW_HEAD = "import { test, expect } from '@playwright/test';\n";

function signalsFor(t, title, body) {
  const [r] = recordsFor(t, PW_HEAD + probe(title, body));
  return { negative: r.negativeSignal, boundary: r.boundarySignal };
}

test('an English negative title is a negative signal', (t) => {
  for (const title of [
    'rejects an invalid email', 'shows an error for a wrong password', 'returns 403 forbidden',
    'unauthorized user cannot export', 'unauthorised access is denied', 'duplicate code is not allowed',
    'expired token fails', 'missing field blocks submit',
  ]) {
    assert.equal(signalsFor(t, title).negative, true, title);
  }
});

test('a Spanish negative title is a signal, accented or not', (t) => {
  for (const title of [
    'rechaza un correo inválido', 'rechaza un correo invalido', 'no permite guardar sin nombre',
    'usuario no autorizado recibe error', 'acceso denegado al perfil', 'campo prohibido',
    'falta el monto', 'valor incorrecto', 'codigo duplicado', 'token vencido', 'token expirado',
    'no puede editar', 'sin permiso para borrar',
  ]) {
    assert.equal(signalsFor(t, title).negative, true, title);
  }
});

test('boundary titles are a boundary signal in both languages, accented or not', (t) => {
  for (const title of [
    'accepts the maximum length', 'at the limit of 10 items', 'empty list shows hint', 'zero quantity',
    'edge case on page break', 'too many rows', 'name too long', 'quantity exceeds stock', 'minimum amount',
    'valor en el límite', 'valor en el limite', 'lista vacía', 'lista vacia', 'monto máximo', 'monto maximo',
    'monto mínimo', 'monto minimo', 'cantidad cero', 'excede el stock', 'supera el tope', 'caso borde',
  ]) {
    assert.equal(signalsFor(t, title).boundary, true, title);
  }
});

test('title matching is word bounded and case-insensitive', (t) => {
  assert.equal(signalsFor(t, 'REJECTS bad input').negative, true);
  assert.equal(signalsFor(t, 'failsafe mode is shown').negative, false, '"fails" inside a longer word');
  assert.equal(signalsFor(t, 'lists the minimal profile').boundary, false, '"min" is not "minimal"');
  assert.equal(signalsFor(t, 'keeps the zeroed counter').boundary, false);
});

test('a test may be both negative and boundary', (t) => {
  assert.deepEqual(signalsFor(t, 'rejects an empty name'), { negative: true, boundary: true });
});

test('a happy-path test carries no signal', (t) => {
  assert.deepEqual(signalsFor(t, 'creates an invoice for the selected customer'), { negative: false, boundary: false });
});

test('a body-only negative is found from toThrow, rejects and 4xx or 5xx statuses', (t) => {
  for (const body of [
    'expect(() => parse("x")).toThrow();',
    'await expect(save()).rejects.toThrow("no");',
    'await expect(save()).rejects.toBeDefined();',
    'expect(response.status()).toBe(400);',
    'expect(res.status()).toEqual(403);',
    'expect(res.status()).toBe(599);',
    'await expect(res).toHaveStatus(404);',
  ]) {
    assert.equal(signalsFor(t, 'handles the request', body).negative, true, body);
  }
});

test('success statuses, rendering assertions and disabled states are not negative signals', (t) => {
  for (const body of [
    'expect(response.status()).toBe(200);',
    'expect(response.status()).toBe(204);',
    'expect(response.status()).toBe(600);',
    'expect(() => parse("1")).not.toThrow();',
    'await expect(page.locator("#a")).not.toBeVisible();',
    'await expect(page.locator("#a")).toBeDisabled();',
  ]) {
    assert.equal(signalsFor(t, 'handles the request', body).negative, false, body);
  }
});

test('a vocabulary word inside a string literal or comment of the body does not count', (t) => {
  const [r] = recordsFor(t, PW_HEAD + [
    "test('creates the record', async ({ page }) => {",
    "  // an invalid, rejected and empty case lives elsewhere; expect(...).toThrow() is not used here",
    "  console.log('invalid input, rejects, toThrow(, status 400, empty');",
    "  await expect(page.locator('#a')).toHaveText('invalid');",
    '});',
  ].join('\n'));

  assert.equal(r.negativeSignal, false);
  assert.equal(r.boundarySignal, false);
});

test('title and body signals are independent', (t) => {
  assert.deepEqual(signalsFor(t, 'maximum length is accepted', 'expect(() => parse("x")).toThrow();'), { negative: true, boundary: true });
  assert.deepEqual(signalsFor(t, 'maximum length is accepted'), { negative: false, boundary: true });
});

test('negative-tests aggregates active tests only, with references and a documented vocabulary', (t) => {
  const records = recordsFor(t, PW_HEAD + [
    probe('rejects an invalid email'),
    probe('empty cart shows hint'),
    probe('rejects an empty name'),
    probe('creates an invoice'),
    "test.skip('rejects a parked case', async () => { await expect(1).toBe(1); });",
  ].join('\n'));

  const item = aggregate(records)['D5.negative-tests'];
  assert.equal(item.evidenceClass, 'inferential');
  assert.equal(item.of, 4, 'the skipped test is outside the population');
  assert.equal(item.negative.count, 2);
  assert.equal(item.boundary.count, 2);
  assert.equal(item.negative.tests.length, 2);
  assert.match(item.negative.tests[0], /^tests\/a\.spec\.ts:\d+$/);
  assert.deepEqual(item.negative.tests, [...item.negative.tests].sort());
  assert.match(item.vocabulary, /NEGATIVE_VOCABULARY/);
});

test('negative-tests is emitted by the extractor, assigns no judgment and sets no threshold', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': CONFIG,
    'tests/a.spec.ts': PW_HEAD + probe('rejects an invalid email') + '\n' + probe('creates an invoice'),
  });

  const item = extractEvidence(root).items['D5.negative-tests'];
  assert.equal(item.negative.count, 1);
  assert.equal(item.of, 2);

  const json = JSON.stringify(item);
  for (const key of ['level', 'score', 'verdict', 'rating', 'threshold', 'cap', 'bound']) {
    assert.ok(!json.includes(`"${key}"`), `evidence must not contain a ${key} key`);
  }
});

test('the vocabulary is exported as one constant holding both lists and the body shapes', () => {
  const { NEGATIVE_VOCABULARY } = require('../src/extract-source.js');
  assert.ok(NEGATIVE_VOCABULARY.negativeTitle instanceof RegExp);
  assert.ok(NEGATIVE_VOCABULARY.boundaryTitle instanceof RegExp);
  assert.ok(NEGATIVE_VOCABULARY.negativeBody instanceof RegExp);
});

// ---------------------------------------------------------------------------
// D3.flaky-markers: a suite's own confession that a test is not deterministic
// ---------------------------------------------------------------------------

function flakyItem(t, source) {
  const root = makeRepo(t, { 'playwright.config.ts': CONFIG, 'tests/a.spec.ts': source });
  return extractEvidence(root).items['D3.flaky-markers'];
}

const FLAKY_HEAD = "import { test, expect } from '@playwright/test';\n";
const FLAKY_BODY = " async ({ page }) => { await expect(page).toHaveTitle('x'); }";

test('flaky-markers counts an @flaky title, case-insensitively and word-bounded', (t) => {
  const item = flakyItem(t, FLAKY_HEAD + [
    `test('[TC-A-001] login @flaky',${FLAKY_BODY});`,
    `test('[TC-A-002] logout @FLAKY',${FLAKY_BODY});`,
    `test('[TC-A-003] stable @flakyness',${FLAKY_BODY});`,
    `test('[TC-A-004] plain',${FLAKY_BODY});`,
  ].join('\n'));

  assert.deepEqual(item.tags.tests, ['tests/a.spec.ts:2', 'tests/a.spec.ts:3']);
  assert.equal(item.tags.count, 2);
  assert.equal(item.count, 2);
});

test('flaky-markers reads a Playwright tag option and an annotation, on tests and describes', (t) => {
  const item = flakyItem(t, FLAKY_HEAD + [
    `test('[TC-A-001] one', { tag: '@flaky' },${FLAKY_BODY});`,
    `test('[TC-A-002] two', { tag: ['@smoke', '@flaky'] },${FLAKY_BODY});`,
    `test('[TC-A-003] three', { annotation: { type: 'flaky', description: 'race' } },${FLAKY_BODY});`,
    `test('[TC-A-004] four', { tag: '@smoke' },${FLAKY_BODY});`,
    `test('[TC-A-005] five', { annotation: { type: 'issue', description: 'flaky' } },${FLAKY_BODY});`,
    "test.describe('group', { tag: '@flaky' }, () => {",
    `  test('[TC-A-006] six',${FLAKY_BODY});`,
    '});',
  ].join('\n'));

  // A flaky describe marks the tests inside it; the describe line itself is not a test.
  assert.deepEqual(item.tags.tests, [
    'tests/a.spec.ts:2', 'tests/a.spec.ts:3', 'tests/a.spec.ts:4', 'tests/a.spec.ts:8',
  ]);
});

test('flaky-markers: a describe titled @flaky marks the tests inside it', (t) => {
  const item = flakyItem(t, FLAKY_HEAD + [
    "test.describe('checkout @flaky', () => {",
    `  test('[TC-A-001] pays',${FLAKY_BODY});`,
    '});',
  ].join('\n'));

  assert.deepEqual(item.tags.tests, ['tests/a.spec.ts:3']);
});

test('flaky-markers records a boolean flakyTag on each test', (t) => {
  const records = recordsFor(t, FLAKY_HEAD + [
    `test('[TC-A-001] a @flaky',${FLAKY_BODY});`,
    `test('[TC-A-002] b',${FLAKY_BODY});`,
  ].join('\n'));

  assert.deepEqual(records.map(r => r.flakyTag), [true, false]);
});

test('flaky-markers: a string literal in code is not a marker', (t) => {
  const item = flakyItem(t, FLAKY_HEAD + [
    "const label = 'this test is flaky and unstable';",
    `test('[TC-A-001] shows the word', async ({ page }) => {`,
    "  await expect(page.locator('#t')).toHaveText('flaky, sometimes fails');",
    '});',
  ].join('\n'));

  assert.equal(item.count, 0);
  assert.deepEqual(item.tags.tests, []);
  assert.deepEqual(item.comments.at, []);
});

test('flaky-markers: a comment is a comment marker and never a tag', (t) => {
  const item = flakyItem(t, FLAKY_HEAD + [
    '// @flaky: fails on slow runners',
    `test('[TC-A-001] plain', { /* tag: '@flaky' */ },${FLAKY_BODY});`,
  ].join('\n'));

  assert.equal(item.tags.count, 0);
  // Both lines are comments that name the problem; neither is a tag.
  assert.deepEqual(item.comments.at, ['tests/a.spec.ts:2', 'tests/a.spec.ts:3']);
  assert.equal(item.count, 2);
});

test('flaky-markers reads single-line and block comments, one hit per line', (t) => {
  const item = flakyItem(t, FLAKY_HEAD + [
    '// this one is flaky, really intermittent', // line 2: two words, one hit
    `test('[TC-A-001] a',${FLAKY_BODY});`,
    '/**',                                       // line 4
    ' * Unstable on CI.',                        // line 5
    ' * nothing to see here',                     // line 6
    ' * race condition with the toast',          // line 7
    ' */',
    `test('[TC-A-002] b',${FLAKY_BODY}); // sometimes fails after deploy`, // line 9
    '// all good here',
  ].join('\n'));

  assert.deepEqual(item.comments.at, [
    'tests/a.spec.ts:2', 'tests/a.spec.ts:5', 'tests/a.spec.ts:7', 'tests/a.spec.ts:9',
  ]);
  assert.equal(item.comments.count, 4);
});

test('flaky-markers matches the English vocabulary', (t) => {
  const phrases = ['flaky', 'flakey', 'flakiness', 'intermittent', 'intermittently', 'unstable', 'sometimes fails', 'fails randomly', 'race condition'];
  const item = flakyItem(t, FLAKY_HEAD + phrases.map(p => `// note: ${p}`).join('\n'));
  assert.equal(item.comments.count, phrases.length);
});

test('flaky-markers matches the Spanish vocabulary, accent-insensitively', (t) => {
  const phrases = [
    'inestable', 'intermitente', 'falla a veces', 'a veces falla', 'falla aleatoriamente',
    'condicion de carrera', 'condición de carrera', 'Condición De Carrera', 'INESTABLE',
  ];
  const item = flakyItem(t, FLAKY_HEAD + phrases.map(p => `// nota: ${p}`).join('\n'));
  assert.equal(item.comments.count, phrases.length);
});

test('flaky-markers uses Unicode word edges, not ASCII ones', (t) => {
  // Longer words that merely contain a term. A term next to an accented
  // letter must not match either, which an ASCII-only \b gets wrong.
  const item = flakyItem(t, FLAKY_HEAD + [
    '// reinestable and inestablez and unstableness are other words',
    '// flakyé and éflaky are not the word',
    '// stable and flakyish and intermittentes2 do not count either',
    '// sin falla a veces2 tampoco',
  ].join('\n'));
  assert.equal(item.comments.count, 0);
});

test('flaky-markers is evidence only: no level, score, verdict, rating, threshold, cap or bound', (t) => {
  const item = flakyItem(t, FLAKY_HEAD + `// flaky\ntest('[TC-A-001] a @flaky',${FLAKY_BODY});`);
  assert.deepEqual(Object.keys(item).sort(), ['comments', 'count', 'tags']);

  const json = JSON.stringify(item);
  for (const key of ['level', 'score', 'verdict', 'rating', 'threshold', 'cap', 'bound']) {
    assert.ok(!json.includes(`"${key}"`), `evidence must not contain a ${key} key`);
  }
});

test('flaky-markers covers every resolved suite file and is emitted with zero counts when clean', (t) => {
  const item = flakyItem(t, FLAKY_HEAD + `test('[TC-A-001] a',${FLAKY_BODY});`);
  assert.deepEqual(item, { count: 0, tags: { count: 0, tests: [] }, comments: { count: 0, at: [] } });
});

// ---------------------------------------------------------------------------
// D7.page-object-usage
// ---------------------------------------------------------------------------

const LAYER_TREE = {
  'playwright.config.ts': CONFIG,
  'tsconfig.json': [
    '{',
    '  // aliases the extractor does not resolve',
    '  "compilerOptions": { "paths": { "@pages/*": ["pages/*"], "@exact": ["x/y"] }, },',
    '}',
  ].join('\n'),
  'pages/LoginPage.ts': [
    "import type { Page } from '@playwright/test';",
    'export class LoginPage {',
    '  constructor(private page: Page) {}',
    "  async login() { await this.page.click('#go'); }",
    '}',
  ].join('\n'),
  'pages/LoginScreen.ts': 'export class LoginScreen { async open() {} }',
  'pages/page-utils.ts': 'export function slug(s) { return s; }',
  'fixtures/base.ts': [
    "import { test as base } from '@playwright/test';",
    "import { LoginPage } from '../pages/LoginPage';",
    'export const test = base.extend<{ loginPage: LoginPage }>({',
    '  loginPage: async ({ page }, use) => { await use(new LoginPage(page)); },',
    '});',
    "export { expect } from '@playwright/test';",
  ].join('\n'),
  'helpers/data.ts': "export function buildUser() { return { name: 'x' }; }",
  // A vendored page object under node_modules must never become a layer.
  'tests/node_modules/decoy/PageDecoy.ts': 'export class PageDecoy { constructor(page) { this.page = page; } }',
  'tests/a.spec.ts': [
    "import { LoginPage } from '../pages/LoginPage';",
    "import { test, expect } from '../fixtures/base';",
    "import { buildUser } from '../helpers/data';",
    "import { Ghost } from '../ghost/Missing';",
    "import { Aliased } from '@pages/Alias';",
    "import { PageDecoy } from './node_modules/decoy/PageDecoy';",
    "test('page object', async ({ page }) => { const lp = new LoginPage(page); await lp.login(); });",
    "test('fixture', async ({ loginPage }) => { await loginPage.login(); });",
    "test('helper', async ({ page }) => { const u = buildUser(); await page.fill('#n', u.name); });",
    "test('inline', async ({ page }) => { await page.click('#go'); });",
    "test('string only', async ({ page }) => { const s = 'loginPage.login() buildUser()'; await page.goto('/'); });",
    "test('neither', async () => { expect(1).toBe(1); });",
    "test('proxy', async ({ page }) => { await verifyTitle(page); });",
  ].join('\n'),
};

function layerItem(t, tree = LAYER_TREE) {
  const item = extractEvidence(makeRepo(t, tree)).items['D7.page-object-usage'];
  assert.ok(item, 'D7.page-object-usage must be emitted');
  return item;
}

test('page-object-usage reports layered and inline tests over the whole suite', (t) => {
  const item = layerItem(t);
  assert.equal(item.evidenceClass, 'inferential');
  assert.deepEqual(item.layeredTests, { count: 4, of: 7, share: 0.571 });
  assert.deepEqual(item.inlineTests, { count: 2 });
});

test('page-object-usage classifies layer files and ignores node_modules', (t) => {
  const item = layerItem(t);
  assert.deepEqual(item.layers.files, ['fixtures/base.ts', 'helpers/data.ts', 'pages/LoginPage.ts']);
  assert.deepEqual(item.layers.kinds, { pageObject: 1, fixture: 1, helper: 1 });
});

test('page-object-usage counts missing, aliased and pruned imports as unresolved', (t) => {
  // Ghost (no such file), Aliased (tsconfig path alias) and PageDecoy (under node_modules).
  assert.equal(layerItem(t).layers.unresolvedImports, 3);
});

test('page-object-usage reports test.extend declarations and the files that hold them', (t) => {
  assert.deepEqual(layerItem(t).customFixtures, { count: 1, files: ['fixtures/base.ts'] });
});

test('page-object-usage classifies a class by file name and a plain module as helper', (t) => {
  const item = layerItem(t, {
    'playwright.config.ts': CONFIG,
    'pages/LoginScreen.ts': 'export class LoginScreen { async open() {} }',
    'pages/page-utils.ts': 'export function slug(s) { return s; }',
    'tests/a.spec.ts': [
      "import { LoginScreen } from '../pages/LoginScreen';",
      "import { slug } from '../pages/page-utils';",
      "test('x', async () => { await new LoginScreen().open(); slug('a'); });",
    ].join('\n'),
  });
  assert.deepEqual(item.layers.kinds, { pageObject: 1, fixture: 0, helper: 1 });
});

test('page-object-usage resolves index files, .js specifiers for .ts sources and require()', (t) => {
  const item = layerItem(t, {
    'playwright.config.ts': CONFIG,
    'pages/home/index.ts': 'export class Home { constructor(page) { this.page = page; } go() {} }',
    'helpers/wait.ts': 'export function settle() {}',
    'helpers/cjs.js': 'module.exports = { run() {} };',
    'tests/a.spec.ts': [
      "import { Home } from '../pages/home';",
      "import { settle } from '../helpers/wait.js';",
      "const cjs = require('../helpers/cjs');",
      "test('x', async ({ page }) => { new Home(page).go(); settle(); cjs.run(); });",
    ].join('\n'),
  });
  assert.deepEqual(item.layers.files, ['helpers/cjs.js', 'helpers/wait.ts', 'pages/home/index.ts']);
  assert.equal(item.layers.unresolvedImports, 0);
});

test('page-object-usage counts test.extend declared in a test file and detects its fixtures', (t) => {
  const item = layerItem(t, {
    'playwright.config.ts': CONFIG,
    'tests/a.spec.ts': [
      "import { test as base } from '@playwright/test';",
      'const test = base.extend({ admin: async ({ page }, use) => { await use(page); } });',
      "test('x', async ({ admin }) => { await admin.goto('/'); });",
    ].join('\n'),
  });
  assert.deepEqual(item.customFixtures, { count: 1, files: ['tests/a.spec.ts'] });
  assert.equal(item.layeredTests.count, 1);
  assert.deepEqual(item.layers.files, []);
});

test('page-object-usage never treats a test file importing another test file as a layer', (t) => {
  const item = layerItem(t, {
    'playwright.config.ts': CONFIG,
    'tests/b.spec.ts': "test('b', async ({ page }) => { await page.goto('/'); });",
    'tests/a.spec.ts': [
      "import './b.spec';",
      "test('a', async ({ page }) => { await page.goto('/'); });",
    ].join('\n'),
  });
  assert.deepEqual(item.layers.files, []);
  assert.deepEqual(item.layeredTests, { count: 0, of: 2, share: 0 });
});

test('page-object-usage is emitted with zero counts when the suite has no layers', (t) => {
  const item = layerItem(t, { 'playwright.config.ts': CONFIG, 'tests/a.spec.ts': "test('x', async ({ page }) => { await page.goto('/'); });" });
  assert.deepEqual(item, {
    evidenceClass: 'inferential',
    layeredTests: { count: 0, of: 1, share: 0 },
    inlineTests: { count: 1 },
    layers: { files: [], kinds: { pageObject: 0, fixture: 0, helper: 0 }, unresolvedImports: 0 },
    customFixtures: { count: 0, files: [] },
  });
});

test('page-object-usage is evidence only: no level, score, verdict or rating key', (t) => {
  const json = JSON.stringify(layerItem(t));
  for (const key of ['level', 'score', 'verdict', 'rating', 'threshold', 'cap', 'bound']) {
    assert.ok(!json.includes(`"${key}"`), `evidence must not contain a ${key} key`);
  }
});

test('per-test records carry a boolean layered flag, true for a delegated assertion without any import', (t) => {
  const records = recordsFor(t, [
    "test('p', async ({ page }) => { await verifyTitle(page); });",
    "test('q', async ({ page }) => { await page.click('#a'); });",
  ].join('\n'));
  assert.deepEqual(records.map(r => r.layered), [true, false]);
});
