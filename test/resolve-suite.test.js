/**
 * resolve-suite.test.js - Tests for the suite boundary resolver.
 *
 * Every rubric metric is computed over the boundary this resolver produces, so
 * a silent error here corrupts every downstream score. The three regression
 * blocks below each reproduce a real defect found during development: all
 * three returned plausible numbers instead of failing, which is the failure
 * mode a measuring instrument cannot have.
 *
 * Fixtures are synthesized in a temp directory rather than pointed at the real
 * QA repositories: those change over time, and a test that drifts with its
 * subject proves nothing.
 */

'use strict';

const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const fs         = require('node:fs');
const os         = require('node:os');
const path       = require('node:path');

const {
  resolveSuite,
  globToRegExp,
  stripComments,
  findTopLevelValue,
  readPatternOption,
  DEFAULT_TEST_MATCH,
} = require('../src/resolve-suite.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Materialize a throwaway repo from a { relativePath: contents } map. */
function makeRepo(t, tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-boundary-'));
  for (const [rel, contents] of Object.entries(tree)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, 'utf8');
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A realistic config: imports defineConfig, has projects, has dead comments. */
function config({ testDir = './tests', testIgnore = null, testMatch = null, projects = true } = {}) {
  const lines = [
    "import { defineConfig, devices } from '@playwright/test';",
    '',
    'export default defineConfig({',
    `  testDir: '${testDir}',`,
    testMatch  ? `  testMatch: ${JSON.stringify(testMatch)},`  : "  // testMatch: ['**/*.spec.ts'],",
    testIgnore ? `  testIgnore: ${JSON.stringify(testIgnore)},` : null,
    '  fullyParallel: true,',
  ];

  if (projects) {
    lines.push(
      '  projects: [',
      "    { name: 'setup', testMatch: /global-setup\\.ts/ },",
      "    { name: 'chromium', testMatch: ['lane-only/**/*.spec.ts'] },",
      '  ],'
    );
  }

  lines.push('});');
  return lines.filter(l => l !== null).join('\n');
}

const SPEC = "import { test, expect } from '@playwright/test';\ntest('x', async () => { expect(1).toBe(1); });\n";

function suiteOf(result, id) {
  const suite = result.suites.find(s => s.id === id);
  assert.ok(suite, `no suite with id ${id}; got ${result.suites.map(s => s.id).join(', ')}`);
  return suite;
}

// ---------------------------------------------------------------------------
// globToRegExp
// ---------------------------------------------------------------------------

test('globToRegExp: Playwright default pattern matches real test filenames', (t) => {
  const re = globToRegExp(DEFAULT_TEST_MATCH[0]);

  for (const ok of [
    'a.spec.ts', 'adm/contratos.spec.ts', 'x/y/z.test.tsx',
    'foo.spec.mts', 'foo.spec.cjs', 'deep/nested/path/thing.test.js',
  ]) {
    assert.ok(re.test(ok), `expected match: ${ok}`);
  }

  for (const no of [
    'helpers/util.ts', 'global-setup.ts', 'readme.md',
    'specs.ts', 'a.spec.txt', 'a.spec.tsx.bak',
  ]) {
    assert.ok(!re.test(no), `expected no match: ${no}`);
  }
});

test('globToRegExp: supports every extglob quantifier', (t) => {
  assert.ok(globToRegExp('@(a|b).ts').test('a.ts'));
  assert.ok(!globToRegExp('@(a|b).ts').test('.ts'), '@() requires exactly one');

  assert.ok(globToRegExp('x?(y).ts').test('x.ts'), '?() allows zero');
  assert.ok(globToRegExp('x?(y).ts').test('xy.ts'), '?() allows one');
  assert.ok(!globToRegExp('x?(y).ts').test('xyy.ts'), '?() rejects two');

  assert.ok(globToRegExp('x*(y).ts').test('x.ts'));
  assert.ok(globToRegExp('x*(y).ts').test('xyyy.ts'));

  assert.ok(!globToRegExp('x+(y).ts').test('x.ts'), '+() requires at least one');
  assert.ok(globToRegExp('x+(y).ts').test('xyy.ts'));
});

test('globToRegExp: character classes pass through, including negation', (t) => {
  assert.ok(globToRegExp('a.[jt]s').test('a.ts'));
  assert.ok(globToRegExp('a.[jt]s').test('a.js'));
  assert.ok(!globToRegExp('a.[jt]s').test('a.cs'));
  assert.ok(globToRegExp('[!x]y.ts').test('ay.ts'));
  assert.ok(!globToRegExp('[!x]y.ts').test('xy.ts'));
});

test('globToRegExp: star does not cross a path separator, globstar does', (t) => {
  assert.ok(globToRegExp('*.spec.ts').test('a.spec.ts'));
  assert.ok(!globToRegExp('*.spec.ts').test('dir/a.spec.ts'));
  assert.ok(globToRegExp('**/a.spec.ts').test('deep/dir/a.spec.ts'));
});

test('globToRegExp: leading globstar is optional so root files still match', (t) => {
  // Playwright treats '**/x.ts' as matching 'x.ts' at the root of testDir.
  assert.ok(globToRegExp('**/seeds/*.spec.ts').test('seeds/a.spec.ts'));
  assert.ok(globToRegExp('**/seeds/*.spec.ts').test('deep/seeds/a.spec.ts'));
  assert.ok(globToRegExp('**/debug-*.spec.ts').test('debug-login.spec.ts'));
});

test('globToRegExp: braces expand and literal dots stay literal', (t) => {
  assert.ok(globToRegExp('a.{ts,js}').test('a.ts'));
  assert.ok(globToRegExp('a.{ts,js}').test('a.js'));
  assert.ok(!globToRegExp('a.ts').test('axts'), 'the dot must not act as a wildcard');
});

// ---------------------------------------------------------------------------
// stripComments
// ---------------------------------------------------------------------------

test('stripComments: removes line and block comments', (t) => {
  assert.equal(stripComments('a // gone\nb').trim(), 'a \nb'.trim());
  assert.equal(stripComments('a /* gone */ b'), 'a  b');
});

test('stripComments: preserves comment-like text inside string literals', (t) => {
  const src = "const u = 'https://example.com/x'; const v = \"/* not a comment */\";";
  const out = stripComments(src);
  assert.ok(out.includes('https://example.com/x'), 'URL must survive');
  assert.ok(out.includes('/* not a comment */'), 'string contents must survive');
});

// ---------------------------------------------------------------------------
// Regression 1: depth-blind option reading
// ---------------------------------------------------------------------------

test('regression: top-level testMatch wins over a project-level testMatch', (t) => {
  // A per-project testMatch narrows which files one lane runs. Reading it as
  // the suite definition reported a 69-file suite as 4 files.
  const src = stripComments(config({ testMatch: ['**/*.spec.ts'] }));
  const opt = readPatternOption(src, 'testMatch');
  assert.deepEqual(opt.patterns, ['**/*.spec.ts']);
});

test('regression: a commented-out testMatch is not read as configuration', (t) => {
  // Every inspected config carries a dead "// testMatch: [...]" line.
  const src = stripComments(config({ testMatch: null }));
  assert.equal(readPatternOption(src, 'testMatch'), null);
});

test('regression: the defineConfig import does not become the config object', (t) => {
  // Anchoring on the identifier found "import { defineConfig }" and treated
  // that import's brace as the start of the config body.
  const src = stripComments(config({ testDir: './custom-dir' }));
  assert.equal(findTopLevelValue(src, 'testDir'), "'./custom-dir'");
});

test('option reading ignores nested keys and reports regex values as unparsed', (t) => {
  const src = stripComments(config({ projects: true }));
  assert.equal(findTopLevelValue(src, 'name'), null, 'project keys are not top level');

  const regexSrc = stripComments(
    "import { defineConfig } from '@playwright/test';\n" +
    'export default defineConfig({ testMatch: /custom\\.ts/ });'
  );
  const opt = readPatternOption(regexSrc, 'testMatch');
  assert.deepEqual(opt.patterns, []);
  assert.equal(opt.unparsed.length, 1);
});

// ---------------------------------------------------------------------------
// Regression 2: vendored and copied suites
// ---------------------------------------------------------------------------

test('regression: node_modules nested inside testDir is excluded', (t) => {
  // A reporter package vendored under tests/ contributed 15 of its own tests,
  // inflating a 14-file suite to 29 even in a hand count that tried to exclude
  // node_modules at the repository root.
  const root = makeRepo(t, {
    'playwright.config.ts': config(),
    'tests/real.spec.ts': SPEC,
    'tests/node_modules/@vendor/pkg/tests/vendor-a.spec.ts': SPEC,
    'tests/node_modules/@vendor/pkg/tests/vendor-b.spec.ts': SPEC,
  });

  const result = resolveSuite(root);
  assert.equal(result.totals.testFiles, 1);
  assert.deepEqual(suiteOf(result, '.').files, ['tests/real.spec.ts']);
  assert.equal(result.totals.unclaimed, 0, 'vendored tests are pruned, not flagged as ambiguous');
});

test('regression: agent worktrees under .claude are excluded', (t) => {
  // One repository reported 522 spec files; 453 of them were worktree copies.
  const root = makeRepo(t, {
    'playwright.config.ts': config(),
    'tests/real.spec.ts': SPEC,
    '.claude/worktrees/agent-abc/tests/copy.spec.ts': SPEC,
    '.claude/worktrees/agent-abc/playwright.config.ts': config(),
  });

  const result = resolveSuite(root);
  assert.equal(result.totals.testFiles, 1);
  assert.equal(result.totals.suites, 1, 'a worktree config must not register as a second suite');
});

test('build output and run artifacts are pruned', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': config(),
    'tests/real.spec.ts': SPEC,
    'test-results/leftover.spec.ts': SPEC,
    'playwright-report/old.spec.ts': SPEC,
    'dist/compiled.spec.ts': SPEC,
  });

  const result = resolveSuite(root);
  assert.equal(result.totals.testFiles, 1);
  assert.equal(result.totals.unclaimed, 0);
});

// ---------------------------------------------------------------------------
// Regression 3: double reporting
// ---------------------------------------------------------------------------

test('regression: a file excluded by testIgnore is not also reported as ambiguous', (t) => {
  // A file decided by an explicit rule is decided. Listing it as both excluded
  // and unclaimed double counts it and invents an ambiguity that does not exist.
  const root = makeRepo(t, {
    'playwright.config.ts': config({ testIgnore: ['**/seeds/*.spec.ts', '**/debug-*.spec.ts'] }),
    'tests/real.spec.ts': SPEC,
    'tests/seeds/setup.spec.ts': SPEC,
    'tests/debug-login.spec.ts': SPEC,
  });

  const result = resolveSuite(root);
  const suite = suiteOf(result, '.');

  assert.equal(suite.count, 1);
  assert.equal(suite.excluded.length, 2);
  assert.equal(result.totals.unclaimed, 0, 'excluded files must not reappear as unclaimed');

  const rules = suite.excluded.map(e => e.rule).sort();
  assert.deepEqual(rules, ['testIgnore:**/debug-*.spec.ts', 'testIgnore:**/seeds/*.spec.ts']);
});

// ---------------------------------------------------------------------------
// Core contract
// ---------------------------------------------------------------------------

test('lifecycle hooks matched by the pattern are excluded with a stated reason', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': config({ testMatch: ['**/*.ts'] }),
    'tests/real.spec.ts': SPEC,
    'tests/global-setup.ts': 'export default async () => {};\n',
  });

  const suite = suiteOf(resolveSuite(root), '.');
  assert.equal(suite.count, 1);
  assert.equal(suite.excluded[0].rule, 'lifecycle-hook-not-a-test');
});

test('a test file outside every testDir is reported as unclaimed', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': config(),
    'tests/real.spec.ts': SPEC,
    'stray.spec.ts': SPEC,
    'scripts/orphan.spec.ts': SPEC,
  });

  const result = resolveSuite(root);
  assert.equal(result.totals.testFiles, 1);
  assert.deepEqual(result.unclaimed, ['scripts/orphan.spec.ts', 'stray.spec.ts']);
});

test('multiple configs produce one suite each, counted separately', (t) => {
  const root = makeRepo(t, {
    'qa/e2e/playwright.config.ts': config({ projects: false }),
    'qa/e2e/tests/a.spec.ts': SPEC,
    'qa/e2e/tests/b.spec.ts': SPEC,
    'qa/integration/playwright.config.ts': config({ projects: false }),
    'qa/integration/tests/c.spec.ts': SPEC,
  });

  const result = resolveSuite(root);
  assert.equal(result.totals.suites, 2);
  assert.equal(result.totals.testFiles, 3);
  assert.equal(suiteOf(result, 'qa/e2e').count, 2);
  assert.equal(suiteOf(result, 'qa/integration').count, 1);
});

test('a repository with no runner config downgrades its own confidence', (t) => {
  const root = makeRepo(t, { 'tests/a.spec.ts': SPEC });
  const result = resolveSuite(root);

  assert.equal(result.confidence, 'heuristic-none-found');
  assert.equal(result.totals.suites, 0);
  assert.deepEqual(result.unclaimed, ['tests/a.spec.ts'], 'candidates are surfaced, not silently scored');
});

test('a missing testDir is surfaced as a warning rather than an empty suite', (t) => {
  const root = makeRepo(t, { 'playwright.config.ts': config({ testDir: './does-not-exist' }) });
  const result = resolveSuite(root);

  assert.equal(result.totals.testFiles, 0);
  assert.ok(result.warnings.some(w => w.includes('testDir does not exist')));
});

// ---------------------------------------------------------------------------
// Reproducibility - the property the whole instrument depends on
// ---------------------------------------------------------------------------

test('two runs over identical input produce byte-identical output', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': config({ testIgnore: ['**/seeds/*.spec.ts'] }),
    'tests/b.spec.ts': SPEC,
    'tests/a.spec.ts': SPEC,
    'tests/nested/c.spec.ts': SPEC,
    'tests/seeds/s.spec.ts': SPEC,
    'stray.spec.ts': SPEC,
  });

  const first  = JSON.stringify(resolveSuite(root), null, 2);
  const second = JSON.stringify(resolveSuite(root), null, 2);
  assert.equal(first, second);
});

test('output carries no timestamp and no absolute path', (t) => {
  // Both would make every run differ from the last, destroying the ability to
  // diff two audits of the same repository months apart.
  const root = makeRepo(t, {
    'playwright.config.ts': config(),
    'tests/a.spec.ts': SPEC,
  });

  const json = JSON.stringify(resolveSuite(root));
  assert.ok(!json.includes(root.replace(/\\/g, '\\\\')), 'no absolute paths');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(json), 'no ISO timestamps');
  assert.ok(!json.includes('\\\\'), 'paths are normalized to forward slashes');
});

test('file lists are sorted regardless of filesystem enumeration order', (t) => {
  const root = makeRepo(t, {
    'playwright.config.ts': config(),
    'tests/zz.spec.ts': SPEC,
    'tests/aa.spec.ts': SPEC,
    'tests/mm.spec.ts': SPEC,
  });

  const files = suiteOf(resolveSuite(root), '.').files;
  assert.deepEqual(files, [...files].sort());
});
