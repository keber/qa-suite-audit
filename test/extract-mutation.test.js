/**
 * extract-mutation.test.js - Tests for the mutation tooling detector.
 *
 * D2.mutation-config is repository evidence that a mutation testing tool is
 * wired in. These tests pin what counts (a well-known config file, or a tool
 * named inside a manifest that declares it) and, as much, what does not: a
 * decoy inside node_modules, a commented-out plugin, a manifest that merely
 * mentions the word.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const { extractMutationConfig } = require('../src/extract-mutation.js');

function makeRepo(t, tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-'));
  for (const [rel, contents] of Object.entries(tree)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, 'utf8');
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function item(root) {
  return extractMutationConfig(root)['D2.mutation-config'];
}

test('a repository with no mutation tooling reports an empty item', (t) => {
  const root = makeRepo(t, {
    'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '^1.40.0' } }),
    'tests/a.spec.ts': "test('x', () => {});",
  });

  assert.deepEqual(item(root), { count: 0, tools: [] });
});

test('Stryker is found by config file name', (t) => {
  const root = makeRepo(t, {
    'stryker.conf.json': '{}',
    'packages/web/stryker.config.mjs': 'export default {};',
    'packages/api/.stryker.conf.cjs': 'module.exports = {};',
  });

  const r = item(root);
  assert.equal(r.count, 3);
  assert.deepEqual(r.tools, [
    { tool: 'stryker', file: 'packages/api/.stryker.conf.cjs', via: 'config-file' },
    { tool: 'stryker', file: 'packages/web/stryker.config.mjs', via: 'config-file' },
    { tool: 'stryker', file: 'stryker.conf.json', via: 'config-file' },
  ]);
});

test('Stryker is found by a dependency on @stryker-mutator in any dependency section', (t) => {
  const root = makeRepo(t, {
    'package.json': JSON.stringify({ devDependencies: { '@stryker-mutator/core': '^8.0.0' } }),
    'packages/lib/package.json': JSON.stringify({ dependencies: { '@stryker-mutator/jest-runner': '^8.0.0' } }),
  });

  const r = item(root);
  assert.equal(r.count, 2);
  assert.ok(r.tools.every(x => x.tool === 'stryker' && x.via === 'dependency'));
  assert.deepEqual(r.tools.map(x => x.file), ['package.json', 'packages/lib/package.json']);
});

test('a package.json that only mentions stryker in a script or description is not evidence', (t) => {
  const root = makeRepo(t, {
    'package.json': JSON.stringify({
      description: 'we should try @stryker-mutator/core one day',
      scripts: { note: 'echo stryker' },
      devDependencies: { 'stryker-unrelated': '1.0.0' },
    }),
  });

  assert.equal(item(root).count, 0);
});

test('an unparseable package.json is skipped rather than failing the audit', (t) => {
  const root = makeRepo(t, { 'package.json': '{ not json @stryker-mutator/core' });
  assert.equal(item(root).count, 0);
});

test('Stryker.NET and infection are found by their well-known config names', (t) => {
  const root = makeRepo(t, {
    'src/App.Tests/stryker-config.json': '{}',
    'infection.json5': '{}',
    'infection.json.dist': '{}',
  });

  const r = item(root);
  assert.equal(r.count, 3);
  assert.deepEqual(
    r.tools.map(x => `${x.tool}:${x.file}`),
    ['infection:infection.json.dist', 'infection:infection.json5', 'stryker-net:src/App.Tests/stryker-config.json'],
  );
});

test('mutmut is found by its section in setup.cfg or pyproject.toml', (t) => {
  const root = makeRepo(t, {
    'svc-a/setup.cfg': '[metadata]\nname = a\n\n[mutmut]\npaths_to_mutate=src/\n',
    'svc-b/pyproject.toml': '[project]\nname = "b"\n\n[tool.mutmut]\npaths_to_mutate = "src/"\n',
  });

  const r = item(root);
  assert.equal(r.count, 2);
  assert.ok(r.tools.every(x => x.tool === 'mutmut' && x.via === 'config-section'));
  assert.deepEqual(r.tools.map(x => x.file), ['svc-a/setup.cfg', 'svc-b/pyproject.toml']);
});

test('a commented-out mutmut section is not evidence', (t) => {
  const root = makeRepo(t, {
    'setup.cfg': '[metadata]\nname = a\n# [mutmut]\n# paths_to_mutate=src/\n',
    'pyproject.toml': '[project]\nname = "b"\n  # [tool.mutmut]\n',
  });

  assert.equal(item(root).count, 0);
});

test('PIT is found in a Maven pom and in Gradle builds', (t) => {
  const root = makeRepo(t, {
    'pom.xml': '<project><build><plugins><plugin><groupId>org.pitest</groupId>'
      + '<artifactId>pitest-maven</artifactId></plugin></plugins></build></project>',
    'app/build.gradle': "plugins {\n  id 'info.solidsoft.pitest' version '1.15.0'\n}\n",
    'lib/build.gradle.kts': 'plugins {\n  id("info.solidsoft.pitest") version "1.15.0"\n}\n',
  });

  const r = item(root);
  assert.equal(r.count, 3);
  assert.ok(r.tools.every(x => x.tool === 'pitest' && x.via === 'build-plugin'));
  assert.deepEqual(r.tools.map(x => x.file), ['app/build.gradle', 'lib/build.gradle.kts', 'pom.xml']);
});

test('a commented-out PIT plugin in a pom or a Gradle build is not evidence', (t) => {
  const root = makeRepo(t, {
    'pom.xml': '<project><!-- <artifactId>pitest-maven</artifactId> --></project>',
    'build.gradle': "// id 'info.solidsoft.pitest'\n/* apply plugin: 'pitest' */\nplugins { id 'java' }\n",
  });

  assert.equal(item(root).count, 0);
});

test('a decoy inside node_modules or another pruned directory is ignored', (t) => {
  const root = makeRepo(t, {
    'node_modules/some-dep/stryker.conf.json': '{}',
    'node_modules/some-dep/package.json': JSON.stringify({ dependencies: { '@stryker-mutator/core': '1' } }),
    'dist/infection.json': '{}',
    '.claude/worktrees/x/stryker.conf.js': 'module.exports = {};',
    'package.json': JSON.stringify({ name: 'app' }),
  });

  assert.deepEqual(item(root), { count: 0, tools: [] });
});

test('paths are repository relative with forward slashes', (t) => {
  const root = makeRepo(t, { 'a/b/c/stryker.conf.js': 'module.exports = {};' });
  assert.equal(item(root).tools[0].file, 'a/b/c/stryker.conf.js');
});

test('the evidence carries no judgment keys', (t) => {
  const root = makeRepo(t, { 'stryker.conf.json': '{}' });
  const json = JSON.stringify(extractMutationConfig(root));
  for (const key of ['level', 'score', 'verdict', 'rating']) {
    assert.ok(!json.includes(`"${key}"`), `evidence must not contain a ${key} key`);
  }
});
