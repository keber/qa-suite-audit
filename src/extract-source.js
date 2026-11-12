#!/usr/bin/env node
/**
 * extract-source.js - Source evidence extractor (calibrated items)
 *
 * Reads the boundary produced by resolve-suite.js and emits per-test evidence
 * for the rubric items whose thresholds were calibrated against real suites:
 *
 *   D1.test-inventory      D2.assertless-tests    D3.fixed-waits
 *   D1.tc-id-coverage      D2.weak-assertions     D3.conditional-waits
 *   D1.ext-id-coverage     D2.assert-density      D3.retries-config
 *                          D2.skipped-tests       D3.serial-mode
 *   D5.priority-distribution
 *   D5.skip-ratio          D4.trace-config        D7.selector-mix
 *                                                 D7.page-object-usage
 *                          D3.flaky-markers
 *                          D4.reporter-config
 *                          D4.artifact-retention
 *
 * The five config items are reported per suite, keyed by suite id, because a
 * repository with two playwright configs has two answers and merging them would
 * hide which suite the retries or the trace setting belong to.
 *
 * This file assigns no scores. It produces counts and per-test records that a
 * rubric level must cite. Attribution is per test, not per file: a file-level
 * assertion count cannot answer "which tests cannot fail", which is the level 0
 * discriminator for sensitivity.
 *
 * Usage:
 *   node extract-source.js <repoPath> [--json] [--out <file>]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { resolveSuite, findTopLevelValue, stripComments, PRUNED_DIRS, relative } = require('./resolve-suite.js');

// ---------------------------------------------------------------------------
// Signal vocabulary
// ---------------------------------------------------------------------------

const ASSERTION      = /\bexpect(?:\.soft)?\s*\(|\bassert(?:\.\w+)?\s*\(/g;
const SOFT_ASSERTION = /\bexpect\.soft\s*\(/g;

/**
 * Assertions that witness only that something rendered. They can pass while the
 * behavior under test is broken, so they cannot carry a test on their own.
 */
const WEAK_ASSERTION = /\.(toBeVisible|toBeAttached|toBeTruthy|toBeDefined)\s*\(\s*\)|\.not\.toBeNull\s*\(\s*\)|\btoHaveURL\s*\(/g;

const FIXED_WAIT       = /\bwaitForTimeout\s*\(|\bsleep\s*\(|\bsetTimeout\s*\(/g;
const CONDITIONAL_WAIT = /\bwaitFor(Selector|LoadState|Response|Request|Function|URL)\s*\(|\bwaitFor\s*\(/g;

const SEL_SEMANTIC = /\bgetBy(Role|Label|Text|Placeholder|Title|AltText)\s*\(/g;
const SEL_TESTID   = /\bgetByTestId\s*\(/g;
const SEL_RAW      = /\.(locator|\$\$?|frameLocator)\s*\(\s*['"`]/g;

const STEP = /\btest\.step\s*\(/g;

/**
 * A call that delegates the assertion to a helper, typically a page object
 * method such as bkIng.verifyValidationMessage('...').
 *
 * Without this, a suite that layers its assertions behind page objects - the
 * structure D7 rewards - is reported as full of tests that cannot fail. A proxy
 * is evidence of an assertion, not proof of one: the helper still has to
 * contain a real check. Proxied tests are therefore reported separately rather
 * than counted as directly asserting.
 */
const ASSERTION_PROXY = /\b(verify|assert|expect|check|should|validate)[A-Z]\w*\s*\(/g;

/**
 * A runtime skip written inside a test body: test.skip(condition, 'reason').
 * It is not a skipped declaration - the test exists and may run - but it means
 * the test can silently not execute, so it is tracked as its own signal rather
 * than folded into either bucket.
 */
const CONDITIONAL_SKIP = /\btest\.(skip|fixme)\s*\(\s*(?!['"`])/g;

/**
 * test.skip(true, 'reason') - a literal, not a condition.
 *
 * This is a declaration-level skip written inside the body, usually to park a
 * case that cannot be automated at all with the reason on record. Reading it as
 * a conditional skip leaves the test counted as active, and since its body
 * never reaches an assertion it then surfaces as a test that cannot fail. It is
 * the opposite: a documented decision not to run.
 */
const UNCONDITIONAL_BODY_SKIP = /\btest\.(skip|fixme)\s*\(\s*true\s*[,)]/;

/**
 * test.fail(...) declares that the test is expected to fail, usually to park a
 * known defect. The runner then reports a passing test as a failure, so such a
 * test cannot go red for the reason it claims to protect. It is a defect
 * marker, not a check.
 */
const EXPECTED_FAILURE = /\btest\.fail\s*\(/g;

/**
 * Assertions that compare against a stored baseline instead of against a value
 * the test states. Counted per test over the MASKED body, so a name inside a
 * string or a comment is not an assertion. This is a signal for D0.suite-type-
 * signals only: what a suite does with it is the judge's reading, not a rule.
 */
const SNAPSHOT_ASSERTION = /\b(?:toMatchSnapshot|toHaveScreenshot|toMatchAriaSnapshot|toMatchInlineSnapshot)\s*\(/g;

/**
 * Whole-word, case-insensitive matcher for a list of terms.
 *
 * \b is ASCII-only in JavaScript, so word edges are spelled with Unicode
 * classes. A space inside a term matches any run of whitespace. Shared by every
 * vocabulary below so they agree on what a word edge is.
 */
const WORD_START = '(?<![\\p{L}\\p{N}_])';
const WORD_END   = '(?![\\p{L}\\p{N}_])';

function wordMatcher(terms) {
  return new RegExp(`${WORD_START}(?:${terms.map(t => t.replace(/ /g, '\\s+')).join('|')})${WORD_END}`, 'iu');
}

/**
 * Negative and boundary vocabulary for D5.negative-tests, in ONE place, English
 * and Spanish, because suites are written in both.
 *
 * The result is a signal, not a proof, and the item says so (inferential).
 * The tradeoffs that stay in the vocabulary on purpose:
 *   - Titles are matched whole-word and case-insensitive, after accents are
 *     stripped, so the lists below are written unaccented and still match
 *     "inválido", "límite" and "vacía". A substring match would fire inside
 *     unrelated words.
 *   - "error", "fail" and "limit" also appear in titles of HAPPY paths ("shows
 *     the error page", "does not fail on reload", "limit selector renders").
 *     Dropping them would miss most real negative titles, so they stay and the
 *     reader is expected to open the listed tests.
 *   - "edge" and "max"/"min" can name a browser or a control rather than a case.
 *   - A negative test with none of these words in its title and no body shape
 *     below is simply not seen. A missing signal is not evidence of absence.
 *
 * Body shapes run over the MASKED source, so a word inside a string or a comment
 * never counts. They are limited to shapes that only make sense for a failing
 * case. `.not.toBeVisible()` and `.toBeDisabled()` are deliberately absent: too
 * common in ordinary flows to say anything. `.not.toThrow(` is excluded because
 * it asserts the success path.
 */
const NEGATIVE_VOCABULARY = (() => {
  const words = wordMatcher;

  return {
    negativeTitle: words([
      // English
      'invalid', 'reject(?:s|ed|ing)?', 'errors?', 'fail(?:s|ed|ure|ures)?', 'unauthori[sz]ed', 'forbidden',
      'denied', 'not allowed', 'cannot', 'can not', "can't", 'missing', 'wrong', 'incorrect',
      'duplicate[ds]?', 'expired',
      // Spanish (unaccented: titles are normalized before matching)
      'invalid[oa]s?', 'rechaz(?:a|an|ado|ada)', 'errores', 'no permit(?:e|en)', 'no autorizad[oa]s?',
      'denegad[oa]s?', 'prohibid[oa]s?', 'falta(?:n)?', 'faltantes?', 'incorrect[oa]s?', 'duplicad[oa]s?',
      'vencid[oa]s?', 'expirad[oa]s?', 'no pued(?:e|en)', 'sin permisos?',
    ]),
    boundaryTitle: words([
      // English
      'limits?', 'boundar(?:y|ies)', 'edge', 'max(?:imum)?', 'min(?:imum)?', 'empty', 'zero', 'overflow',
      'exceed(?:s|ed)?', 'too long', 'too many',
      // Spanish (unaccented)
      'limites?', 'borde', 'maxim[oa]s?', 'minim[oa]s?', 'vaci[oa]s?', 'cero', 'excede(?:n)?', 'supera(?:n)?',
    ]),
    // toThrow / rejects, and a 4xx or 5xx literal compared with a response status.
    negativeBody: /(?<!\.not)\.toThrow(?:Error)?\s*\(|\.rejects\s*\.|\btoHaveStatus\s*\(\s*[45]\d\d\b|\bstatus(?:\s*\(\s*\))?\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\s*\(\s*[45]\d\d\b/,
  };
})();

/**
 * What a suite says about its own determinism, for D3.flaky-markers.
 *
 * Two readings, kept apart on purpose:
 *   - flakyTitle: the @flaky tag, matched against a test title or a tag value.
 *     It is a convention, so it needs the "@" and a word edge after it.
 *   - flakyComment: prose in COMMENTS only. A string literal that happens to
 *     say "flaky" is test data, not a confession. The vocabulary is written
 *     unaccented and matched after accents are folded, like the negative lists.
 *
 * Evidence for the judge, never a threshold: a comment that says "race
 * condition" may describe the application under test rather than the test.
 */
const FLAKY_VOCABULARY = {
  flakyTitle: new RegExp(`(?<![\\p{L}\\p{N}_])@flaky${WORD_END}`, 'iu'),
  flakyComment: wordMatcher([
    // English
    'flaky', 'flakey', 'flakiness', 'intermittent(?:ly)?', 'unstable', 'sometimes fails', 'fails randomly',
    'race conditions?',
    // Spanish (unaccented)
    'inestables?', 'intermitentes?', 'falla a veces', 'a veces falla', 'falla aleatoriamente',
    'condicion(?:es)? de carrera',
  ]),
};

/** Strip accents so one unaccented vocabulary covers both spellings. */
function foldAccents(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '');
}

/** Case id such as TC-CON-002 or TC-0014. Letters may precede the number. */
const DEFAULT_CASE_ID = /\bTC-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+\b|\bTC-\d+\b/i;
/** External work item id at the head of a title, such as [27499]. */
const EXTERNAL_ID = /^\s*\[(\d{4,7})\]/;
/** Declared priority, either @P0 or [P0]. */
const PRIORITY    = /@P(\d)\b|\[P(\d)\]/;

// ---------------------------------------------------------------------------
// Source masking
// ---------------------------------------------------------------------------

/**
 * Blank out comment bodies and string literal contents while preserving every
 * offset and newline.
 *
 * Offsets must survive because test titles are read back from the original
 * source at positions found in the masked copy. Masking string contents also
 * means a bracket or an "expect(" inside a message literal cannot corrupt the
 * structural scan.
 */
function maskSource(src) {
  const out = src.split('');
  let i = 0;
  let quote = null;

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    if (quote) {
      if (c === '\\') { blank(out, i); blank(out, i + 1); i += 2; continue; }
      if (c === quote) { quote = null; i++; continue; }
      blank(out, i); i++; continue;
    }

    if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue; }

    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { blank(out, i); i++; }
      continue;
    }

    if (c === '/' && n === '*') {
      const end  = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let j = i; j < stop; j++) blank(out, j);
      i = stop; continue;
    }

    i++;
  }

  return out.join('');
}

function blank(out, i) {
  if (out[i] !== undefined && out[i] !== '\n') out[i] = ' ';
}

/**
 * Offset ranges [start, end) of every comment, using the same quote tracking as
 * maskSource so a "//" inside a string is not a comment.
 *
 * maskSource cannot be diffed against the raw text to find comments: it blanks
 * string contents too, so a changed character does not say which kind it was.
 */
function findComments(src) {
  const ranges = [];
  let i = 0;
  let quote = null;

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i++; continue;
    }

    if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue; }

    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      ranges.push([i, stop]);
      i = stop; continue;
    }

    if (c === '/' && n === '*') {
      const end  = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      ranges.push([i, stop]);
      i = stop; continue;
    }

    i++;
  }

  return ranges;
}

/** The source with every comment blanked (offsets and newlines preserved) and strings intact. */
function blankComments(src, ranges = findComments(src)) {
  const out = src.split('');
  for (const [from, to] of ranges) for (let j = from; j < to; j++) blank(out, j);
  return out.join('');
}

/**
 * Lines of comments that talk about flakiness, as 'file:line' references.
 * Read from the raw text, but only inside comment ranges. A block comment is
 * judged line by line so each hit points at the line a reader should open.
 */
function scanFlakyComments(src, relPath) {
  const hits = [];

  for (const [from, to] of findComments(src)) {
    const firstLine = lineAt(src, from);
    src.slice(from, to).split('\n').forEach((text, k) => {
      if (FLAKY_VOCABULARY.flakyComment.test(foldAccents(text))) hits.push(`${relPath}:${firstLine + k}`);
    });
  }

  return hits;
}

/** Index of the ')' closing the '(' at openIdx, or -1. */
function matchParen(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

// ---------------------------------------------------------------------------
// Test discovery
// ---------------------------------------------------------------------------

const DECLARATION = /\btest\s*(?:\.\s*(describe|skip|only|fixme|step|fail|slow)\s*(?:\.\s*(skip|only|fixme|serial|parallel)\s*)?)?\(/g;

/**
 * Locate every test declaration in one file.
 *
 * A call is a test declaration only when its first argument is a string literal
 * and its argument list contains a function. That second condition separates
 * `test.skip('title', async () => {})` - a skipped test - from
 * `test.skip(browserName === 'firefox', 'reason')`, a conditional skip written
 * inside another test's body. Counting the latter as a test inflates the suite
 * and invents a skipped test that does not exist.
 */
function findTests(src) {
  const masked = maskSource(src);
  // Strings kept, comments gone: the tag and annotation options are read from
  // here so a commented-out `tag: '@flaky'` is not a tag.
  const uncommented = blankComments(src);
  const groups = [];
  const tests  = [];

  DECLARATION.lastIndex = 0;
  let m;

  while ((m = DECLARATION.exec(masked)) !== null) {
    const kind     = m[1] ?? null;
    const modifier = m[2] ?? null;
    const openIdx  = m.index + m[0].length - 1;
    const closeIdx = matchParen(masked, openIdx);
    if (closeIdx === -1) continue;

    const argsMasked = masked.slice(openIdx + 1, closeIdx);
    const argsRaw    = src.slice(openIdx + 1, closeIdx);

    if (kind === 'step') continue;

    const firstQuote = /^\s*(['"`])/.exec(argsRaw);
    const hasFunction = /=>|\bfunction\b/.test(argsMasked);
    if (!firstQuote || !hasFunction) continue;

    const title = readFirstString(argsRaw);
    if (title === null) continue;

    const record = {
      title,
      line: lineAt(src, m.index),
      start: openIdx,
      end: closeIdx,
      skipped: modifier === 'skip' || modifier === 'fixme' || kind === 'skip' || kind === 'fixme',
      only: modifier === 'only' || kind === 'only',
      // Declared as expected to fail. The body slice starts after the call
      // name, so a declaration-level test.fail is invisible to a body scan.
      declaredFailure: kind === 'fail' || modifier === 'fail',
      flakyTag: hasFlakyTag(title, uncommented.slice(openIdx + 1, closeIdx), argsMasked),
    };

    if (kind === 'describe') groups.push(record);
    else tests.push(record);
  }

  // A test inside a skipped describe is skipped, however it is declared.
  for (const t of tests) {
    const owner = groups.find(g => g.start < t.start && t.end < g.end);
    if (owner) {
      t.group = owner.title;
      if (owner.skipped) t.skipped = true;
    }
    // A tag on any enclosing describe, at any depth, applies to the test.
    if (groups.some(g => g.flakyTag && g.start < t.start && t.end < g.end)) t.flakyTag = true;
  }

  return { tests, groups, masked };
}

/**
 * Is a declaration marked flaky: @flaky in its title, a `tag:` option holding
 * @flaky, or an `annotation` with type 'flaky'.
 *
 * Options sit between the title and the callback, so only that stretch is read.
 * Reading the whole argument list of a describe would pick up tags that belong
 * to the tests inside it, and those are attributed to their own declarations.
 * argsRaw has comments blanked; argsMasked locates the callback.
 */
function hasFlakyTag(title, argsRaw, argsMasked) {
  if (FLAKY_VOCABULARY.flakyTitle.test(title)) return true;

  const q = /^\s*(['"`])/.exec(argsRaw);
  if (!q) return false;
  const afterTitle = argsRaw.indexOf(q[1]) + 1 + title.length + 1;
  const callback   = argsMasked.search(/=>|\bfunction\b/);
  const options    = argsRaw.slice(afterTitle, callback === -1 ? argsRaw.length : callback);

  const tag = /\btag\s*:\s*(\[[^\]]*\]|['"`][^'"`]*['"`])/.exec(options);
  if (tag && FLAKY_VOCABULARY.flakyTitle.test(tag[1])) return true;

  const annotation = /\bannotation\s*:\s*(\{[^{}]*\}|\[[\s\S]*?\])/.exec(options);
  return Boolean(annotation && /\btype['"`]?\s*:\s*(['"`])flaky\1/i.test(annotation[1]));
}

function readFirstString(argsRaw) {
  const q = /^\s*(['"`])/.exec(argsRaw);
  if (!q) return null;
  const quote = q[1];
  const from  = argsRaw.indexOf(quote) + 1;
  for (let i = from; i < argsRaw.length; i++) {
    if (argsRaw[i] === '\\') { i++; continue; }
    if (argsRaw[i] === quote) return argsRaw.slice(from, i);
  }
  return null;
}

/**
 * Serial execution declared in source: describe.serial(...) and
 * describe.configure({ mode: 'serial' }).
 *
 * Both are found on the masked copy so a mention inside a string or comment is
 * not counted. The configure call is the exception on the argument side: the
 * word 'serial' is a string literal, which masking blanks, so the options are
 * read back from the raw source at the same offsets.
 */
const SERIAL_DESCRIBE    = /\btest\s*\.\s*describe\s*\.\s*serial\s*\(/g;
const DESCRIBE_CONFIGURE = /\btest\s*\.\s*describe\s*\.\s*configure\s*\(/g;
const SERIAL_MODE        = /\bmode\s*:\s*(['"`])serial\1/;

function countSerialDeclarations(src) {
  const masked = maskSource(src);
  let configured = 0;

  DESCRIBE_CONFIGURE.lastIndex = 0;
  let m;
  while ((m = DESCRIBE_CONFIGURE.exec(masked)) !== null) {
    const openIdx  = m.index + m[0].length - 1;
    const closeIdx = matchParen(masked, openIdx);
    if (closeIdx === -1) continue;
    if (SERIAL_MODE.test(src.slice(openIdx + 1, closeIdx))) configured++;
  }

  return { describeSerial: countIn(masked, SERIAL_DESCRIBE), configuredSerial: configured };
}

function countIn(text, re) {
  re.lastIndex = 0;
  const found = text.match(re);
  return found ? found.length : 0;
}

// ---------------------------------------------------------------------------
// Layers: page objects, fixtures, helpers (D7.page-object-usage)
// ---------------------------------------------------------------------------

/**
 * How the layers a suite is built on are found. INFERENTIAL, and kept simple on
 * purpose: this is an import graph one level deep over masked source, not a
 * module resolver.
 *
 *   Layer file    a file a suite test file imports through a RELATIVE specifier
 *                 (import ... from './x', import './x', require('../x')) that
 *                 resolves, with .ts .js .mjs .cjs .tsx or /index.*, to a file
 *                 inside the repository and is not itself a suite test file.
 *                 Type-only imports are skipped: they leave no runtime layer.
 *   Kind          pageObject when the file declares a class that takes `page` in
 *                 its constructor or stores `this.page =`, or its basename says
 *                 page/screen/component and it exports a class; fixture when it
 *                 calls .extend( on test/base; otherwise helper.
 *   Layered test  its masked body calls something bound to an imported layer
 *                 symbol (Sym(...), Sym.m(...), or inst.m(...) where
 *                 inst = new Sym(...) anywhere in the file), or uses a fixture
 *                 declared by test.extend as a destructured parameter, or
 *                 delegates an assertion (ASSERTION_PROXY).
 *   Inline test   calls page.* or request.* in its own body and is not layered.
 *
 * Known blind spots, reported rather than hidden:
 *   - Path aliases (tsconfig/jsconfig `paths`, e.g. '@pages/...') and baseUrl
 *     imports are not resolved. Aliased imports matching a `paths` key, relative
 *     imports that resolve to nothing, and relative imports that land inside a
 *     PRUNED_DIRS directory all count in layers.unresolvedImports. A suite that
 *     imports everything through aliases looks like it has no layers; read the
 *     count before reading the share.
 *   - Only direct imports of test files are followed. A page object reached
 *     through a fixtures file is seen via the fixture, not as its own layer.
 *   - `test`, `expect` and `base` imported from a fixtures file are Playwright's
 *     own, not layer calls. A custom fixture named like a built-in (`page`,
 *     `request`...) is not treated as a layer either.
 *   - Fixture names are the identifier keys of the object passed to .extend();
 *     quoted keys are missed. A fixture holding plain data is only seen if the
 *     test calls it (data.x.y()), so data fixtures under-count.
 *   - A helper that does not touch the page still counts as layered when called;
 *     the item says a test is built on shared code, not that the code is good.
 */
const RESOLVE_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs', '.tsx'];
const PLAYWRIGHT_OWN     = new Set(['test', 'expect', 'base']);
const BUILTIN_FIXTURES   = new Set(['page', 'context', 'browser', 'request', 'browserName']);

const ES_IMPORT      = /\bimport\s+(type\s+)?([^;'"`]*?)\s*\bfrom\s*(['"])([^'"\n]+)\3/g;
const BARE_IMPORT    = /\bimport\s*(['"])([^'"\n]+)\1/g;
const REQUIRE_CALL   = /(?:\b(?:const|let|var)\s+([^=;]+?)\s*=\s*)?\brequire\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g;
const EXTEND_CALL    = /\b(?:test|base|[A-Za-z_]\w*Test)\s*\.\s*extend\s*(?:<[^()]*?>)?\s*\(/g;
const DIRECT_PAGE_API = /(?<![\w$.])(?:page|request)\s*\??\.\s*[\w$]+/g;

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Does any directory segment of a repo-relative path belong to PRUNED_DIRS? */
function insidePrunedDir(rel) {
  return rel.split('/').slice(0, -1).some(seg => PRUNED_DIRS.has(seg));
}

/** Repo-relative path of the file a relative specifier points at, or null. */
function resolveRelativeImport(repoRoot, fromRel, spec) {
  const base = path.resolve(repoRoot, path.dirname(fromRel), spec);
  // TypeScript ESM writes './x.js' for a source file named x.ts.
  const stem = base.replace(/\.[cm]?js$/, '');
  const candidates = [
    ...(RESOLVE_EXTENSIONS.includes(path.extname(base)) ? [base] : []),
    ...RESOLVE_EXTENSIONS.map(e => base + e),
    ...(stem !== base ? RESOLVE_EXTENSIONS.map(e => stem + e) : []),
    ...RESOLVE_EXTENSIONS.map(e => path.join(base, 'index' + e)),
  ];

  const hit = candidates.find(isFile);
  if (!hit) return null;

  const rel = relative(repoRoot, hit);
  return rel.startsWith('..') || insidePrunedDir(rel) ? null : rel;
}

/**
 * Specifier prefixes declared under `paths` in the nearest tsconfig.json or
 * jsconfig.json above a file. Only the keys are read: the point is to recognise
 * an import as an alias, not to resolve it. `extends` chains are not followed.
 */
function aliasMatchers(repoRoot, fromRel, cache) {
  let dir = path.resolve(repoRoot, path.dirname(fromRel));
  const root = path.resolve(repoRoot);

  for (;;) {
    if (cache.has(dir)) return cache.get(dir);

    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const file = path.join(dir, name);
      if (!isFile(file)) continue;
      const matchers = readAliasKeys(file);
      cache.set(dir, matchers);
      return matchers;
    }

    if (dir === root || path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }

  cache.set(path.resolve(repoRoot, path.dirname(fromRel)), []);
  return [];
}

function readAliasKeys(file) {
  try {
    const text = stripComments(fs.readFileSync(file, 'utf8')).replace(/,(\s*[}\]])/g, '$1');
    const paths = JSON.parse(text)?.compilerOptions?.paths ?? {};
    return Object.keys(paths).map(key => ({ key, prefix: key.replace(/\*.*$/, ''), exact: !key.includes('*') }));
  } catch {
    return [];
  }
}

function isAlias(spec, matchers) {
  return matchers.some(m => (m.exact ? spec === m.key : m.prefix !== '' && spec.startsWith(m.prefix)));
}

/** Local binding names introduced by an import or require clause. */
function boundNames(clause) {
  const names = [];
  const c = (clause ?? '').trim();
  if (!c) return names;

  const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(c);
  if (ns) names.push(ns[1]);

  const braces = /\{([^}]*)\}/.exec(c);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const p = part.trim().replace(/^type\s+/, '');
      if (!p) continue;
      // ES: `a as b`, CommonJS destructuring: `a: b`. The local name is last.
      const renamed = /(?:\bas\s+|:\s*)([A-Za-z_$][\w$]*)\s*$/.exec(p);
      names.push(renamed ? renamed[1] : p.replace(/\s.*$/, ''));
    }
  }

  const head = c.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+[\w$]+/, '').replace(/,/g, ' ').trim();
  if (/^[A-Za-z_$][\w$]*$/.test(head)) names.push(head);

  return names;
}

/** Every runtime import of one file: { spec, names }. Comments are blanked first. */
function readImports(src) {
  const text   = blankComments(src);
  const masked = maskSource(src);
  const found  = [];
  // A keyword inside a string literal is blank in the masked copy.
  const live = (m) => masked[m.index] === text[m.index];

  for (const m of text.matchAll(ES_IMPORT)) {
    if (live(m) && !m[1]) found.push({ spec: m[4], names: boundNames(m[2]) });
  }
  for (const m of text.matchAll(BARE_IMPORT)) {
    if (live(m)) found.push({ spec: m[2], names: [] });
  }
  for (const m of text.matchAll(REQUIRE_CALL)) {
    if (live(m)) found.push({ spec: m[3], names: boundNames(m[1]) });
  }

  return found;
}

/** Identifier keys at the top level of the object literal passed to each .extend( call. */
function readExtendDeclarations(masked) {
  const out = [];
  EXTEND_CALL.lastIndex = 0;
  let m;

  while ((m = EXTEND_CALL.exec(masked)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchParen(masked, openParen);
    const brace = masked.indexOf('{', openParen);
    const keys = [];

    if (closeParen !== -1 && brace !== -1 && brace < closeParen) {
      let depth = 0;
      for (let i = brace; i < closeParen; i++) {
        const c = masked[i];
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === '}' || c === ')' || c === ']') depth--;
        else if (depth === 1 && /[A-Za-z_$]/.test(c) && !/[\w$]/.test(masked[i - 1] ?? '')) {
          const key = /^([A-Za-z_$][\w$]*)\s*:/.exec(masked.slice(i));
          const before = masked.slice(brace, i).trimEnd().slice(-1);
          if (key && (before === '{' || before === ',')) keys.push(key[1]);
        }
      }
    }
    out.push(keys);
  }

  return out;
}

function classifyLayerFile(masked, relPath, declaresExtend) {
  const hasClass = /\bclass\s+[A-Za-z_$][\w$]*/.test(masked);
  const ctor     = /\bconstructor\s*\(([^)]*)\)/.exec(masked);
  const takesPage = Boolean(ctor && /\bpage\b/.test(ctor[1])) || /\bthis\s*\.\s*page\s*=/.test(masked);
  const named    = /page|screen|component/i.test(path.basename(relPath, path.extname(relPath)));

  if (hasClass && takesPage) return 'pageObject';
  if (named && /\bexport\s+(?:default\s+)?class\b/.test(masked)) return 'pageObject';
  if (declaresExtend) return 'fixture';
  return 'helper';
}

/**
 * Read the layers of one suite: which files its tests import, what kind each is,
 * which symbols and fixtures each test file can reach, and what could not be
 * resolved. Built once per suite so a test body can be judged without rereading.
 */
function buildLayerIndex(repoRoot, suiteFiles) {
  const suiteSet = new Set(suiteFiles);
  const aliasCache = new Map();
  const kinds = new Map();         // layer file -> kind
  const declarations = new Map();  // file -> number of .extend( declarations
  const unresolved = new Map();    // test file -> unresolved import count
  const byFile = new Map();        // test file -> { symbols, fixtures }
  const layerInfo = new Map();     // layer file -> { fixtureKeys }

  const inspectLayer = (rel) => {
    if (layerInfo.has(rel)) return layerInfo.get(rel);
    const masked = maskSource(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
    const extended = readExtendDeclarations(masked);
    const info = { fixtureKeys: extended.flat() };
    kinds.set(rel, classifyLayerFile(masked, rel, extended.length > 0));
    if (extended.length) declarations.set(rel, extended.length);
    layerInfo.set(rel, info);
    return info;
  };

  for (const file of suiteFiles) {
    const src = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const symbols = new Set();
    const fixtures = new Set();
    let misses = 0;

    const own = readExtendDeclarations(maskSource(src));
    if (own.length) declarations.set(file, own.length);
    own.flat().forEach(k => fixtures.add(k));

    for (const { spec, names } of readImports(src)) {
      if (/^\.{1,2}(?:\/|$)/.test(spec)) {
        const rel = resolveRelativeImport(repoRoot, file, spec);
        if (!rel) { misses++; continue; }
        if (suiteSet.has(rel)) continue;
        inspectLayer(rel).fixtureKeys.forEach(k => fixtures.add(k));
        names.filter(n => !PLAYWRIGHT_OWN.has(n)).forEach(n => symbols.add(n));
      } else if (isAlias(spec, aliasMatchers(repoRoot, file, aliasCache))) {
        misses++;
      }
    }

    BUILTIN_FIXTURES.forEach(n => fixtures.delete(n));
    if (misses) unresolved.set(file, misses);
    byFile.set(file, { symbols, fixtures });
  }

  return { byFile, kinds, declarations, unresolved };
}

/** Fold several suite indexes into the extras `aggregate` reads. */
function layerExtras(...indexes) {
  const kinds = new Map();
  const declarations = new Map();
  const unresolved = new Map();
  for (const ix of indexes) {
    ix.kinds.forEach((v, k) => kinds.set(k, v));
    ix.declarations.forEach((v, k) => declarations.set(k, v));
    ix.unresolved.forEach((v, k) => unresolved.set(k, v));
  }

  const count = (kind) => [...kinds.values()].filter(v => v === kind).length;
  return {
    layers: {
      files: [...kinds.keys()].sort(),
      kinds: { pageObject: count('pageObject'), fixture: count('fixture'), helper: count('helper') },
      unresolvedImports: [...unresolved.values()].reduce((a, b) => a + b, 0),
    },
    customFixtures: {
      count: [...declarations.values()].reduce((a, b) => a + b, 0),
      files: [...declarations.keys()].sort(),
    },
  };
}

/** Names a test callback destructures from its first parameter: async ({ a, b: c }) => */
function destructuredParams(body) {
  const m = /\(\s*\{([^{}]*)\}\s*(?:,[^)]*)?\)\s*(?:=>|\{)/.exec(body);
  if (!m) return [];
  return m[1].split(',')
    .map(p => p.split('=')[0].trim())
    .map(p => (p.includes(':') ? p.split(':')[1].trim() : p))
    .filter(p => /^[A-Za-z_$][\w$]*$/.test(p));
}

/** A call on, or a method call through, any of the given names. */
function callsAny(body, names) {
  if (!names.length) return false;
  const alt = names.map(n => n.replace(/\$/g, '\\$')).join('|');
  return new RegExp(`(?<![\\w$.])(?:${alt})(?:\\s*\\??\\.\\s*[\\w$]+)*\\s*\\(`).test(body);
}

/** Layer reach of one test file: its symbols, and the instances built from them. */
function layerNames(masked, reach) {
  const instances = [];
  for (const sym of reach.symbols) {
    const re = new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?new\\s+${sym.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
    for (const m of masked.matchAll(re)) instances.push(m[1]);
  }
  return [...reach.symbols, ...instances];
}

// ---------------------------------------------------------------------------
// Per-file extraction
// ---------------------------------------------------------------------------

/**
 * Which risk ids a test file cites, read from the RAW source.
 *
 * Deliberately not masked. Every other scan here blanks comments so that a
 * signal inside a string cannot be counted as code, but a risk citation lives
 * in the header comment that explains why the test exists. Masking it away
 * would hide the one place the reasoning is written down.
 */
function scanRiskRefs(repoRoot, relPath, scanner) {
  if (typeof scanner !== 'function') return [];
  return scanner(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
}

/**
 * @param {object|null} [layerIndex] from buildLayerIndex. Without it a test can
 *   only be layered through an assertion proxy: nothing is known about imports.
 */
function extractFile(repoRoot, relPath, caseIdPattern = DEFAULT_CASE_ID, layerIndex = null) {
  const src = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  const { tests, masked } = findTests(src);

  const reach  = layerIndex?.byFile.get(relPath) ?? { symbols: new Set(), fixtures: new Set() };
  const names  = layerNames(masked, reach);

  const records = tests.map(t => {
    // Structural counts run over the masked body so that a signal appearing
    // inside a string literal is never counted as code.
    const body = masked.slice(t.start, t.end + 1);

    const usedFixtures = destructuredParams(body).filter(p => reach.fixtures.has(p));
    const proxies      = countIn(body, ASSERTION_PROXY);
    const layered      = proxies > 0 || callsAny(body, [...names, ...usedFixtures]);

    const assertions = countIn(body, ASSERTION);
    const title      = t.title;
    const priority   = PRIORITY.exec(title);

    return {
      file: relPath,
      line: t.line,
      title,
      group: t.group ?? null,
      skipped: t.skipped || UNCONDITIONAL_BODY_SKIP.test(body),
      only: t.only,
      caseId:     (caseIdPattern.exec(title) || [null])[0],
      externalId: (EXTERNAL_ID.exec(title) || [null, null])[1],
      priority:   priority ? `P${priority[1] ?? priority[2]}` : null,
      // Title is read raw (not masked): the vocabulary lives in the words a
      // human wrote. The body is masked so a string cannot trigger it.
      negativeSignal:
        NEGATIVE_VOCABULARY.negativeTitle.test(foldAccents(title)) || NEGATIVE_VOCABULARY.negativeBody.test(body),
      boundarySignal: NEGATIVE_VOCABULARY.boundaryTitle.test(foldAccents(title)),
      flakyTag: Boolean(t.flakyTag),
      assertions,
      softAssertions:  countIn(body, SOFT_ASSERTION),
      weakAssertions:   countIn(body, WEAK_ASSERTION),
      fixedWaits:       countIn(body, FIXED_WAIT),
      conditionalWaits: countIn(body, CONDITIONAL_WAIT),
      steps:            countIn(body, STEP),
      assertionProxies: proxies,
      layered,
      // page.* / request.* written in the test itself, the raw material of the
      // inline reading in D7.page-object-usage.
      directPageCalls:  countIn(body, DIRECT_PAGE_API),
      conditionalSkips: countIn(body, CONDITIONAL_SKIP),
      expectedFailures: countIn(body, EXPECTED_FAILURE) + (t.declaredFailure ? 1 : 0),
      snapshotAssertions: countIn(body, SNAPSHOT_ASSERTION),
      selectors: {
        semantic: countIn(body, SEL_SEMANTIC),
        testId:   countIn(body, SEL_TESTID),
        raw:      countIn(body, SEL_RAW),
      },
    };
  });

  return records;
}

// ---------------------------------------------------------------------------
// Config extraction
// ---------------------------------------------------------------------------

function extractConfig(repoRoot, configRelPath) {
  const src = stripComments(fs.readFileSync(path.join(repoRoot, configRelPath), 'utf8'));
  const raw = (key) => {
    const v = findTopLevelValue(src, key);
    return v === null ? null : v.replace(/^['"`]|['"`]$/g, '');
  };

  const useBlock = findTopLevelValue(src, 'use') ?? '';
  const inUse = (key) => {
    const hit = new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`]*)\\1`).exec(useBlock);
    return hit ? hit[2] : null;
  };

  return {
    config: configRelPath,
    retries:      raw('retries') ?? readExpression(src, 'retries'),
    workers:      raw('workers') ?? readExpression(src, 'workers'),
    fullyParallel: readExpression(src, 'fullyParallel'),
    reporters:    readReporters(src),
    trace:        inUse('trace'),
    screenshot:   inUse('screenshot'),
    video:        inUse('video'),
    outputDir:    raw('outputDir') ?? readExpression(src, 'outputDir'),
  };
}

/**
 * Reporter names only.
 *
 * A reporter entry is either a bare string or a ['name', { options }] tuple, so
 * a scan for every string literal in the block also returns option values such
 * as 'never' and 'playwright-report' and reports them as reporters.
 */
function readReporters(src) {
  const block = findTopLevelValue(src, 'reporter');
  if (!block) return [];
  if (block.startsWith("'") || block.startsWith('"')) return [block.slice(1, -1)];

  const names = [];
  const TUPLE = /\[\s*(['"`])([^'"`]+)\1/g;
  let m;
  while ((m = TUPLE.exec(block)) !== null) names.push(m[2]);

  if (names.length) return names;
  return [...block.matchAll(/(['"`])([^'"`]+)\1/g)].map(x => x[2]);
}

/** Read a non-string top-level value, such as `retries: process.env.CI ? 2 : 1`. */
function readExpression(src, key) {
  const anchor = new RegExp(`\\b${key}\\s*:\\s*([^,\\n]+)`).exec(src);
  return anchor ? anchor[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function ratio(a, b) {
  return b === 0 ? null : Math.round((a / b) * 1000) / 1000;
}

/**
 * @param {object[]} records per-test records
 * @param {{flakyComments?: string[], layers?: object, customFixtures?: object}} [extras]
 *   facts that live outside any test body and so cannot be derived from records:
 *   comment lines per file, and the layer files and fixture declarations found
 *   by buildLayerIndex (see layerExtras).
 */
function aggregate(records, extras = {}) {
  const total   = records.length;
  const active  = records.filter(r => !r.skipped);
  const sum     = (f) => records.reduce((n, r) => n + f(r), 0);

  const assertless    = active.filter(r => r.assertions === 0 && r.assertionProxies === 0);
  const indirectOnly  = active.filter(r => r.assertions === 0 && r.assertionProxies > 0);
  const weakOnly      = active.filter(r => r.assertions > 0 && r.assertions === r.weakAssertions);
  const negativeTests = active.filter(r => r.negativeSignal);
  const boundaryTests = active.filter(r => r.boundarySignal);
  const semantic      = sum(r => r.selectors.semantic);
  const testId        = sum(r => r.selectors.testId);
  const rawSelectors  = sum(r => r.selectors.raw);
  const flakyTagged   = records.filter(r => r.flakyTag).map(ref).sort();
  const flakyComments = [...(extras.flakyComments ?? [])].sort();
  const layeredTests  = records.filter(r => r.layered);
  const inlineTests   = records.filter(r => !r.layered && r.directPageCalls > 0);
  const layers = extras.layers ?? {
    files: [], kinds: { pageObject: 0, fixture: 0, helper: 0 }, unresolvedImports: 0,
  };
  const customFixtures = extras.customFixtures ?? { count: 0, files: [] };

  return {
    // D1
    'D1.test-inventory':   { tests: total, files: new Set(records.map(r => r.file)).size },
    'D1.tc-id-coverage':   { withCaseId: records.filter(r => r.caseId).length, of: total, ratio: ratio(records.filter(r => r.caseId).length, total) },
    'D1.ext-id-coverage':  { withExternalId: records.filter(r => r.externalId).length, of: total, ratio: ratio(records.filter(r => r.externalId).length, total) },

    // D2
    'D2.assertless-tests': { count: assertless.length, of: active.length, tests: assertless.map(ref).sort() },
    'D2.indirect-assertions': {
      count: indirectOnly.length,
      of: active.length,
      proxyCalls: sum(r => r.assertionProxies),
      evidenceClass: 'inferential',
      tests: indirectOnly.map(ref).sort(),
    },
    'D2.weak-assertions':  { weakOnlyTests: weakOnly.length, weakAssertions: sum(r => r.weakAssertions), tests: weakOnly.map(ref).sort() },
    'D2.assert-density':   { assertions: sum(r => r.assertions), perActiveTest: ratio(sum(r => r.assertions), active.length) },
    'D2.soft-assertions':  { count: sum(r => r.softAssertions) },
    'D2.skipped-tests':    { count: total - active.length, of: total, ratio: ratio(total - active.length, total) },
    'D2.only-markers':     { count: records.filter(r => r.only).length },
    'D2.conditional-skips': { count: sum(r => r.conditionalSkips), tests: records.filter(r => r.conditionalSkips > 0).map(ref).sort() },
    'D2.expected-failures': { count: records.filter(r => r.expectedFailures > 0).length, tests: records.filter(r => r.expectedFailures > 0).map(ref).sort() },

    // D3
    'D3.fixed-waits':       { count: sum(r => r.fixedWaits), perTest: ratio(sum(r => r.fixedWaits), total), tests: records.filter(r => r.fixedWaits > 0).map(ref).sort() },
    'D3.conditional-waits': { count: sum(r => r.conditionalWaits), perTest: ratio(sum(r => r.conditionalWaits), total) },
    // Every test, skipped or not: a suite's own admission of non-determinism
    // does not depend on the test currently running. Evidence for the judge.
    'D3.flaky-markers': {
      count: flakyTagged.length + flakyComments.length,
      tags: { count: flakyTagged.length, tests: flakyTagged },
      comments: { count: flakyComments.length, at: flakyComments },
    },

    // D4
    'D4.failure-context': { steps: sum(r => r.steps), testsWithSteps: records.filter(r => r.steps > 0).length },

    // D5
    'D5.priority-distribution': tally(records.map(r => r.priority)),
    'D5.skip-ratio':            { ratio: ratio(total - active.length, total) },
    // Active tests only: a skipped test does not protect anything. Evidence for
    // the judge, never a threshold - see NEGATIVE_VOCABULARY for what it misses.
    'D5.negative-tests': {
      evidenceClass: 'inferential',
      negative: { count: negativeTests.length, tests: negativeTests.map(ref).sort() },
      boundary: { count: boundaryTests.length, tests: boundaryTests.map(ref).sort() },
      of: active.length,
      vocabulary: 'NEGATIVE_VOCABULARY in src/extract-source.js (documented in docs/EVIDENCE-CATALOGUE.md, D5.negative-tests)',
    },

    // D7
    'D7.selector-mix': {
      semantic, testId, raw: rawSelectors,
      semanticShare: ratio(semantic + testId, semantic + testId + rawSelectors),
    },
    'D7.file-size': summarizeFiles(records),
    // Every test, skipped or not: how a suite is built does not depend on
    // whether a case currently runs. Evidence for the judge, never a threshold -
    // see "Layers" above for what the import reading cannot see.
    'D7.page-object-usage': {
      evidenceClass: 'inferential',
      layeredTests: { count: layeredTests.length, of: total, share: ratio(layeredTests.length, total) },
      inlineTests: { count: inlineTests.length },
      layers,
      customFixtures,
    },
  };
}

/**
 * The five config-derived items, one entry per suite.
 *
 * These are facts read from the config and the suite's sources, never a verdict
 * on them: whether retries of 2 are load tolerance or flake suppression is the
 * agent's call (D3), and whether a trace setting is enough to diagnose is D4's.
 */
function configItems(suites) {
  const bySuite = (pick) => Object.fromEntries(suites.map(s => [s.id, { config: s.config, ...pick(s) }]));

  return {
    'D3.retries-config': { bySuite: bySuite(s => ({ retries: s.configEvidence.retries })) },
    'D3.serial-mode': {
      bySuite: bySuite(s => ({
        fullyParallel: s.configEvidence.fullyParallel,
        workers: s.configEvidence.workers,
        ...s.serialDeclarations,
      })),
    },
    'D4.reporter-config': { bySuite: bySuite(s => ({ reporters: s.configEvidence.reporters })) },
    'D4.trace-config': {
      bySuite: bySuite(s => ({
        trace: s.configEvidence.trace,
        screenshot: s.configEvidence.screenshot,
        video: s.configEvidence.video,
      })),
    },
    // Only the config half of retention is read here. Whether the CI run
    // publishes the output folder is D6.result-publication.
    'D4.artifact-retention': { bySuite: bySuite(s => ({ outputDir: s.configEvidence.outputDir })) },
  };
}

function ref(r) {
  return `${r.file}:${r.line}`;
}

function tally(values) {
  const out = {};
  for (const v of values) {
    const key = v ?? 'none';
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function summarizeFiles(records) {
  const byFile = {};
  for (const r of records) byFile[r.file] = (byFile[r.file] ?? 0) + 1;
  const counts = Object.values(byFile);
  return {
    files: counts.length,
    maxTestsInOneFile: counts.length ? Math.max(...counts) : 0,
    medianTestsPerFile: median(counts),
  };
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function extractEvidence(repoRoot, options = {}) {
  const caseIdPattern = options.caseIdPattern ?? DEFAULT_CASE_ID;
  const boundary = resolveSuite(repoRoot);
  const layerIndexes = [];

  const suites = boundary.suites.map(suite => {
    const layerIndex = buildLayerIndex(repoRoot, suite.files);
    layerIndexes.push(layerIndex);
    const records = suite.files.flatMap(f => extractFile(repoRoot, f, caseIdPattern, layerIndex));
    const serialDeclarations = suite.files
      .map(f => countSerialDeclarations(fs.readFileSync(path.join(repoRoot, f), 'utf8')))
      .reduce((a, b) => ({
        describeSerial: a.describeSerial + b.describeSerial,
        configuredSerial: a.configuredSerial + b.configuredSerial,
      }), { describeSerial: 0, configuredSerial: 0 });

    const flakyComments = suite.files.flatMap(f =>
      scanFlakyComments(fs.readFileSync(path.join(repoRoot, f), 'utf8'), f));

    return {
      id: suite.id,
      config: suite.config,
      configEvidence: extractConfig(repoRoot, suite.config),
      serialDeclarations,
      flakyComments,
      items: aggregate(records, { flakyComments, ...layerExtras(layerIndex) }),
      tests: records.sort((a, b) => (a.file + a.line).localeCompare(b.file + b.line)),
    };
  });

  const all = suites.flatMap(s => s.tests);

  const riskReferences = boundary.suites
    .flatMap(s => s.files)
    .map(file => ({ file, risks: scanRiskRefs(repoRoot, file, options.riskRefScanner) }))
    .filter(entry => entry.risks.length)
    .sort((a, b) => a.file.localeCompare(b.file));

  return {
    schema: 'suite-evidence/v1',
    repo: boundary.repo,
    riskReferences,
    boundary: {
      confidence: boundary.confidence,
      testFiles: boundary.totals.testFiles,
      unclaimed: boundary.totals.unclaimed,
    },
    items: {
      ...aggregate(all, { flakyComments: suites.flatMap(s => s.flakyComments), ...layerExtras(...layerIndexes) }),
      ...configItems(suites),
    },
    suites,
    warnings: boundary.warnings,
  };
}

function printHuman(result) {
  const i = result.items;
  console.log(`Repo: ${result.repo}   files=${result.boundary.testFiles}   tests=${i['D1.test-inventory'].tests}`);
  console.log('');
  console.log(`  D1.tc-id-coverage     ${i['D1.tc-id-coverage'].withCaseId}/${i['D1.tc-id-coverage'].of}`);
  console.log(`  D1.ext-id-coverage    ${i['D1.ext-id-coverage'].withExternalId}/${i['D1.ext-id-coverage'].of}`);
  console.log(`  D2.assertless-tests   ${i['D2.assertless-tests'].count}/${i['D2.assertless-tests'].of} active`);
  console.log(`  D2.weak-assertions    ${i['D2.weak-assertions'].weakOnlyTests} tests assert only rendering`);
  console.log(`  D2.assert-density     ${i['D2.assert-density'].perActiveTest} per active test`);
  console.log(`  D2.skipped-tests      ${i['D2.skipped-tests'].count}/${i['D2.skipped-tests'].of}  (${Math.round((i['D2.skipped-tests'].ratio ?? 0) * 100)}%)`);
  console.log(`  D2.only-markers       ${i['D2.only-markers'].count}`);
  console.log(`  D2.conditional-skips  ${i['D2.conditional-skips'].count}`);
  console.log(`  D2.expected-failures  ${i['D2.expected-failures'].count}`);
  console.log(`  D2.indirect-assert.   ${i['D2.indirect-assertions'].count} tests assert only via helpers (${i['D2.indirect-assertions'].proxyCalls} proxy calls)`);
  console.log(`  D3.fixed-waits        ${i['D3.fixed-waits'].count}  (${i['D3.fixed-waits'].perTest} per test)`);
  console.log(`  D3.conditional-waits  ${i['D3.conditional-waits'].count}`);
  console.log(`  D3.flaky-markers      ${i['D3.flaky-markers'].tags.count} tagged tests, ${i['D3.flaky-markers'].comments.count} comment lines`);
  console.log(`  D4.failure-context    ${i['D4.failure-context'].steps} steps in ${i['D4.failure-context'].testsWithSteps} tests`);
  console.log(`  D7.selector-mix       semantic=${i['D7.selector-mix'].semantic} testId=${i['D7.selector-mix'].testId} raw=${i['D7.selector-mix'].raw}  share=${i['D7.selector-mix'].semanticShare}`);
  const po = i['D7.page-object-usage'];
  console.log(`  D7.page-object-usage  ${po.layeredTests.count}/${po.layeredTests.of} layered, ${po.inlineTests.count} inline, ${po.layers.files.length} layer files, ${po.customFixtures.count} test.extend, ${po.layers.unresolvedImports} unresolved imports`);
  console.log('');

  for (const s of result.suites) {
    const c = s.configEvidence;
    console.log(`  config ${c.config}`);
    console.log(`    retries=${c.retries}  workers=${c.workers}  fullyParallel=${c.fullyParallel}`);
    console.log(`    trace=${c.trace}  screenshot=${c.screenshot}  video=${c.video}  reporters=${c.reporters.join(',') || '(none)'}`);
  }
}

function main() {
  const args    = process.argv.slice(2);
  const repoArg = args.find(a => !a.startsWith('--'));

  if (!repoArg) {
    console.error('Usage: node extract-source.js <repoPath> [--json] [--out <file>]');
    process.exit(2);
  }

  const result = extractEvidence(path.resolve(repoArg));
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

module.exports = { extractEvidence, extractFile, buildLayerIndex, findTests, maskSource, findComments, scanFlakyComments, aggregate, countSerialDeclarations, DEFAULT_CASE_ID, NEGATIVE_VOCABULARY };
