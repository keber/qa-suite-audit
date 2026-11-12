/**
 * catalogue.test.js - The evidence catalogue and the extractors must agree.
 *
 * The catalogue is the vocabulary the judging agent reads, and the validator
 * rejects any cited id the scripts did not emit. A catalogue that documents an
 * item nobody produces trains the agent to cite something that gets rejected,
 * so drift in either direction is a defect. This test makes it loud.
 *
 * Format it parses (see the note at the top of the catalogue): an item is a
 * table row whose first cell is exactly one backticked id. Prose, thresholds
 * and the calibration table are never read. Rows under a "D<n> - ..." heading
 * are extracted items; rows under "Not extracted in v1" are documented
 * absences.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const { prepare } = require('../src/judge-prep.js');

const CATALOGUE = path.join(__dirname, '..', 'docs', 'EVIDENCE-CATALOGUE.md');
const NOT_EXTRACTED_HEADING = 'Not extracted in v1';
const ITEM_ROW = /^\|\s*`(D\d+\.[a-z0-9-]+)`\s*\|/;

function parseCatalogue() {
  const extracted = [];
  const notExtracted = [];
  let section = null;

  for (const line of fs.readFileSync(CATALOGUE, 'utf8').split(/\r?\n/)) {
    const h = /^##\s+(.*\S)\s*$/.exec(line);
    if (h) { section = h[1]; continue; }

    const row = ITEM_ROW.exec(line);
    if (!row) continue;

    if (section === NOT_EXTRACTED_HEADING) notExtracted.push(row[1]);
    else if (section && /^D\d+ - /.test(section)) extracted.push(row[1]);
    else assert.fail(`item row ${row[1]} sits under "${section}", which is neither a dimension nor "${NOT_EXTRACTED_HEADING}"`);
  }

  return { extracted, notExtracted };
}

function makeRepo(t, tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogue-'));
  for (const [rel, contents] of Object.entries(tree)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, 'utf8');
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const SPEC_BASE = 'qa/01-specifications/module-ADM/submodule-CON';

const FIXTURE = {
  'playwright.config.ts': [
    "import { defineConfig } from '@playwright/test';",
    'export default defineConfig({',
    "  testDir: './tests',",
    '  retries: 1,',
    '  workers: 1,',
    "  use: { trace: 'retain-on-failure' },",
    '});',
  ].join('\n'),
  'tests/con.spec.ts': [
    "import { test, expect } from '@playwright/test';",
    "test('[TC-CON-001] access', async ({ page }) => { await expect(page.locator('#a')).toHaveText('1'); });",
  ].join('\n'),
  [`${SPEC_BASE}/01-business-rules.md`]: '# Reglas\n## RN-ADM-CON-001 -- Acceso\nTexto.\n',
  [`${SPEC_BASE}/05-test-scenarios.md`]: [
    '| ID | Titulo | Notas |', '|---|---|---|', '| TC-CON-001 | Acceso | RN-ADM-CON-001 |',
  ].join('\n'),
  'qa/pipelines/ci.yml': [
    'trigger:', '  branches:', '    include:', '      - master',
    'steps:', '  - script: npx playwright test', "    workingDirectory: 'tests'",
  ].join('\n'),
};

test('the catalogue lists exactly the item ids the extractors emit', (t) => {
  const { extracted } = parseCatalogue();
  const input = prepare(makeRepo(t, FIXTURE));

  const emitted = [
    ...Object.keys(input.items.source),
    ...Object.keys(input.items.rules),
    ...Object.keys(input.items.pipelines),
  ].sort();

  const documented = [...extracted].sort();

  assert.deepEqual(
    emitted.filter(id => !documented.includes(id)),
    [],
    'emitted but undocumented: add a row to the dimension table in docs/EVIDENCE-CATALOGUE.md',
  );
  assert.deepEqual(
    documented.filter(id => !emitted.includes(id)),
    [],
    'documented as extracted but never emitted: emit it, or move the row under "Not extracted in v1"',
  );
  assert.equal(new Set(documented).size, documented.length, 'an item is listed twice in the dimension tables');
});

test('no item is both extracted and declared not extracted', () => {
  const { extracted, notExtracted } = parseCatalogue();

  assert.ok(notExtracted.length > 0, 'the not-extracted section must exist and carry rows');
  assert.deepEqual(notExtracted.filter(id => extracted.includes(id)), []);
  assert.equal(new Set(notExtracted).size, notExtracted.length, 'an item is listed twice under not extracted');
});

test('a not-extracted item is never emitted', (t) => {
  const { notExtracted } = parseCatalogue();
  const input = prepare(makeRepo(t, FIXTURE));
  const emitted = new Set([
    ...Object.keys(input.items.source),
    ...Object.keys(input.items.rules),
    ...Object.keys(input.items.pipelines),
  ]);

  assert.deepEqual(notExtracted.filter(id => emitted.has(id)), [],
    'emitted now: move the row into its dimension table');
});
