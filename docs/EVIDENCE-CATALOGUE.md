# Evidence Catalogue - v1

The rubric these items feed is not this project's work. The seven dimensions,
their level definitions and the verdict rules come from "Como saber si tus tests
automatizados sirven: la rubrica de 7 criterios para auditar una suite" by
Adriana Troche Robles, published on Calidad sin Humo:
https://calidadsinhumo.com/guias/rubrica-para-juzgar-una-suite-de-tests/

This document only describes what evidence a level can be made to cite.

Scope: **repository evidence only**. No CI API, no run history, no branch policies.

This catalogue defines what the scripts extract. It does not assign scores.

**For editors:** an item is a table row whose first cell is one backticked id.
Rows under a `D<n> - ...` heading are items the scripts emit today; rows under
"Not extracted in v1" are items they do not. `test/catalogue.test.js` fails if
that split disagrees with what `prepare()` actually emits, so add a row in the
same change as the extractor, and never list a not-yet-extracted item in a
dimension table.

## Contract

```
scripts  ->  evidence items  (deterministic, diffable, no judgment)
agent    ->  rubric level    (judgment, must cite item ids)
```

An agent that gathers and judges in the same step produces a score that cannot
be diffed across runs: when the number moves, nobody can tell whether the suite
changed or the model did. Every level assignment must name the evidence items
that support it, and an item the scripts did not produce cannot support a level.
Items v1 does not produce are listed in one place, "Not extracted in v1", so an
agent never reads one as citable.

Item ids are stable: `D<dimension>.<slug>`. They are the vocabulary the agent
prompt and the report both speak.

## Ceilings

A level the repository cannot witness is not scored. It is declared unreachable.

| # | Dimension | Ceiling | Binding constraint |
|---|---|---|---|
| 1 | Oracle | 3 | needs a rule inventory in-repo (drops to 1 without one) |
| 2 | Sensitivity | 3 | level 3 needs measured sensitivity; capped at 2 when no mutation config is committed (calibrated, see D2) |
| 3 | Determinism | 2 | level 3 asserts run behavior, not source state |
| 4 | Diagnosis | 3 | - |
| 5 | Business rule coverage | **2** | level 3 needs the deliberate exclusions written down (drops to 1 without a rule inventory) |
| 6 | Life in CI | 1 | "blocks the merge" lives in the branch policy |
| 7 | Maintainability | 2 | level 3 needs review and retirement process evidence |

Totals: **16 of 21** with a rule inventory, **13 of 21** without one.

D5 was first estimated at 3. That was wrong: its level 3 text has two halves, and
while the covered and uncovered rules are both computable from the catalogue,
"which ones are left out ON PURPOSE" is a statement of intent that only a person
writes. v1 extracts no such statement, so the honest ceiling is 2.

Report the total as `obtained / attainable`, never over 21, and do not apply the
source rubric's verdict bands: they were calibrated for complete evidence.

---

## D0 - Suite type

> What kind of suite this is, before anything is scored. Not a dimension: it has
> no level, no ceiling and no weight in the total.

| Item | Measures | Extraction |
|---|---|---|
| `D0.suite-type-signals` | per suite and per top-level test directory (the first path segment under the suite's resolved test root; files directly in the root group as `.`), as `suites[].directories[]` each with a `key` (`<suite id>/<directory>`, e.g. `./legacy`): `tests`; `defectIds` (`count` of tests whose title or file name carries a defect id, and up to five `examples` as `file:line`); `expectedFailures.count` (tests with `test.fail`, the same reading as `D2.expected-failures`); `snapshotAssertions.count` (tests asserting through `toMatchSnapshot(`, `toHaveScreenshot(`, `toMatchAriaSnapshot(` or `toMatchInlineSnapshot(` in their masked body); `caseIds.count` (tests whose title carries a case id); `caseIdsLinkedToRules.count` (those whose case id the specification links to a declared rule). Every count is a number of tests, skipped ones included. **Inferential** | `DEFECT_ID` in `src/suite-type.js`: `/\b(?:DEF\|BUG\|DEFECT\|ISSUE\|INC\|HOTFIX)[-_][A-Z0-9-]*\d+\b/i`, read over titles and file base names (a defect id is not a case id: `TC-CON-001` names a scenario, `BUG-0042` names a known defect); per-test counts from `extractFile`; case-to-rule link from `linkedCaseIds` in `src/traceability.js`, after the adapter |

**Group keys.** A group's `key` is `<suite id>/<directory>`. The suite id is the
repository-relative folder of the runner config, and `.` when the config sits at
the repository root, so a root suite's directories read `./legacy`, `./api`, and
files directly in the test root give `./.` (suite `.`, directory `.`). A suite
in `a/` with a `tests/e2e` folder gives `a/e2e`. A verdict copies keys verbatim.

**Signals only.** The scripts never say which kind of suite this is, and the item
carries no type or classification. The verdict declares `suiteType`
(`regression`, `defect-harness`, `characterization` or `mixed`, with a
per-directory breakdown for `mixed`) and must cite `D0.suite-type-signals`; the
validator checks it is declared, cited and, for `mixed`, covers every `key`
above. No bound reads this item: the suite type changes how a judge reads D1 and
D5, not where any ceiling, cap or floor sits (issue #10 is open on purpose).

**Reading it.** Defect ids and expected failures in a directory suggest a pinned
defect harness; snapshot assertions with few linked case ids suggest
characterization; many case ids linked to rules suggest a regression net. These
are readings for the judge, not rules: a title can name a defect it merely
regression-tests, and a missing id is not proof of its absence.

---

## D1 - Oracle

> Where does "correct" come from.

| Item | Measures | Extraction |
|---|---|---|
| `D1.test-inventory` | every test: file, title, line | parse `test(...)` / `test.describe(...)` |
| `D1.tc-id-coverage` | tests whose title carries a case id (`TC-XXX-000`) | regex over titles |
| `D1.ext-id-coverage` | tests whose title carries an external work item id (`[27499]`) | regex over titles |
| `D1.rule-inventory` | rule documents present and rule ids declared | scan `01-specifications/**/01-business-rules.md` or equivalent |
| `D1.spec-linkage` | case ids in tests that resolve to a documented case or rule | join `D1.tc-id-coverage` against `D1.rule-inventory` |
| `D1.automated-case-ids` | distinct case ids carried by test titles, upper-cased; the set `D5.covered-rules` and `D5.orphan-tests` are computed from | union of `caseId` over all tests |
| `D1.risk-inventory` | a risk register is present (`_risks.md` beside the specifications): its path, risk count, severity tally and the declared risks | adapter read; `present: false` when absent |

**Discriminates:** 0 vs 1 vs 2 from `D1.spec-linkage` density. An unlinked
suite cannot exceed 1.

**Left to judgment:** whether a linked expected value genuinely encodes the rule
or merely cites it. A test can carry `[TC-CON-002]` and still assert whatever
the system happened to return. Only reading spec and test together settles this,
which is why 2 vs 3 is the agent's call.

**Note:** an external work item id is not a rule reference. It points at a
ticket, not at a rule. `D1.ext-id-coverage` is reported separately so the two
are never conflated.

---

## D2 - Sensitivity

> Whether it goes red for the right reason.

| Item | Measures | Extraction |
|---|---|---|
| `D2.assertless-tests` | active tests with neither an assertion nor an assertion proxy | per-test body scan |
| `D2.indirect-assertions` | tests asserting only through a helper such as `page.verifyX()` | proxy-name scan, **inferential** |
| `D2.weak-assertions` | assertions that only witness page load (`toBeVisible` on a container, bare `toHaveURL`, `not.toBeNull`) | classify assertion calls |
| `D2.assert-density` | assertions per active test | ratio |
| `D2.skipped-tests` | declarations: `test.skip`, `test.fixme`, `describe.skip` | declaration scan |
| `D2.conditional-skips` | runtime skips inside a body: `test.skip(condition, reason)` | body scan |
| `D2.expected-failures` | `test.fail(...)`, which inverts the meaning of green | body scan |
| `D2.soft-assertions` | `expect.soft` usage, which downgrades failure to warning | regex |
| `D2.only-markers` | tests declared `test.only` or `describe.only`; a committed `only` silences every other test in its scope | declaration scan |
| `D2.mutation-config` | mutation testing tooling configured in the repository: `{ count, tools: [{ tool, file, via }] }`; repository level, not per suite | config file names and manifest content: Stryker, Stryker.NET, mutmut, PIT, infection |

**Assertion proxies.** A suite that layers assertions behind page objects has
tests whose bodies contain no `expect(`. Counting those as assertless accuses the
best-structured suite of the worst defect, so a call matching
`verify|assert|check|should|validate` + CapitalizedName rescues the test from
`D2.assertless-tests` and lands it in `D2.indirect-assertions` instead. That item
is **inferential**: it proves a delegation, not a check. Whether the helper
actually asserts is the agent's to confirm.

**Expected failures are not skips.** `test.fail()` parks a known defect: the
runner reports a *passing* test as a failure. Such a test cannot go red for the
behavior it names, and it is neither skipped nor asserting, so it is counted on
its own.

**Mutation config.** Identified by well-known config file names (`stryker.conf.*`,
`stryker.config.*`, `.stryker.conf*`, `stryker-config.json` for Stryker.NET,
`infection.json`, `infection.json5`, `infection.json.dist`) or by what a manifest
declares: an `@stryker-mutator/*` entry in a `package.json` dependency section, a
`[mutmut]` section in `setup.cfg` or `[tool.mutmut]` in `pyproject.toml`, `pitest-maven`
or `org.pitest` in `pom.xml`, the `info.solidsoft.pitest` or `pitest` plugin in a Gradle
build. Commented-out declarations do not count. The walk prunes the same
directories as suite resolution (`node_modules`, `dist`, `.claude`, ...), so a tool's
own files cannot pass as this repository's configuration. `via` says how the tool
was recognised: `config-file`, `dependency`, `config-section` or `build-plugin`.

**Discriminates:** level 0 mechanically, from `D2.assertless-tests` plus
`D2.weak-assertions`, and a cap at 2 when `D2.mutation-config.count` is 0
(threshold `D2.sensitivity-measured`). That cap is a **calibration**, not a literal
reading, because the rubric's level 3 is a disjunction: "se probó rompiendo la regla
a propósito, o hay mutation testing corriendo". Mutation config is repository
evidence for the second half only. A rule broken on purpose to watch the test fail
leaves no trace v1 can read, so the cap can wrongly hold back a suite verified that
way. In the other direction, config present does not prove mutation testing is
running: it lifts the cap, nothing more. Level 3 is never floored or settled by this
item and still has to be argued by the judge, citing `D2.mutation-config` and what the
configuration shows. When both this cap and the systemic assertless cap apply, the
lower one (0) wins.

**Left to judgment:** 1 vs 2 - whether a test fails for causes unrelated to what
it claims to protect. Needs reading the test.

**Note:** a skipped test cannot fail. `D2.skipped-tests` is evidence here and in
D5, and a high ratio caps this dimension regardless of the rest.

---

## D3 - Determinism

> Ceiling 2. Level 3 asserts behavior across runs; the repository cannot witness it.

| Item | Measures | Extraction |
|---|---|---|
| `D3.fixed-waits` | `waitForTimeout`, `sleep`, bare `setTimeout` in test code | regex, normalized per test |
| `D3.conditional-waits` | `waitForSelector`, `waitForLoadState`, expect polling | regex |
| `D3.flaky-markers` | the suite's own admissions of non-determinism: `tags` lists tests marked `@flaky` in a title, a `tag:` option or an `annotation: { type: 'flaky' }` (a marked `describe` marks the tests inside it); `comments` lists each comment line that says flaky, flakey, flakiness, intermittent, unstable, sometimes fails, fails randomly or race condition, or the Spanish inestable, intermitente, falla a veces, a veces falla, falla aleatoriamente, condicion de carrera (accent-insensitive); `count` is both together | tag scan on declarations; comment-only scan (strings in code never count) |
| `D3.retries-config` | configured retries, verbatim (`2` or `process.env.CI ? 2 : 1`), reported per suite as `bySuite[<suite id>].retries` | config read |
| `D3.serial-mode` | per suite: `fullyParallel` and `workers` as configured, plus counts of `describe.serial` and `describe.configure({ mode: 'serial' })` in the suite's files | config read and masked-source scan |

**Discriminates:** 0 vs 1 vs 2. `D3.retries-config` above zero plus
`D3.fixed-waits` above zero is strong evidence against level 2. The rubric's
"measured" wording would need committed run reports to witness, and
`D3.committed-run-artifacts` is not extracted, so that requirement is not
enforced today.

**Left to judgment:** whether retries are a load-tolerance decision or a flake
suppressor. Configs sometimes explain themselves in comments; the agent reads them.
`D3.flaky-markers` is evidence, not a threshold: a comment that says "race
condition" may describe the application rather than the test, and a suite
that never writes the word is not thereby deterministic. Open the listed lines.

---

## D4 - Diagnosis

> What it tells you when it fails.

| Item | Measures | Extraction |
|---|---|---|
| `D4.trace-config` | `trace`, `screenshot`, `video` settings from `use`, reported per suite | config read |
| `D4.reporter-config` | reporter names configured (options are not reported as reporters), per suite | config read |
| `D4.failure-context` | custom messages on assertions, `test.step` usage, annotations | regex |
| `D4.artifact-retention` | the configured `outputDir` per suite (`null` when unset). Whether CI publishes it is `D6.result-publication`; the two are never merged | config read |

**Discriminates:** 0 vs 1 vs 2 mechanically from `D4.trace-config` and
`D4.failure-context`.

**Left to judgment:** 2 vs 3 - whether the report names the broken business rule
without opening code. That is a reading of the test titles in `D1.test-inventory` against
`D1.rule-inventory`, not a count. `D4.title-quality` would pre-classify them
and is not extracted.

---

## D5 - Business rule coverage

> Needs a rule inventory. Ceiling 1 without one.

| Item | Measures | Extraction |
|---|---|---|
| `D5.rule-catalogue` | rules declared in specs, with ids | parse rule documents |
| `D5.covered-rules` | rules with at least one test linked via case id | join with `D1.spec-linkage` |
| `D5.uncovered-rules` | declared rules with no linked test | set difference |
| `D5.orphan-tests` | tests whose case id resolves to no declared rule | set difference, other direction |
| `D5.priority-distribution` | tests by declared priority tag (`@P0`, `[P1]`) | regex over titles |
| `D5.skip-ratio` | skipped share of the suite | from `D2.skipped-tests` |
| `D5.pending-markers` | count of `PENDING-CODE` markers across rule documents: information the analysis could not confirm | adapter scan |
| `D5.risk-coverage` | risks from `D1.risk-inventory` cited by a test file, and those never cited; kept apart from rule coverage and **inferential**, since a citation is not an assertion | join of the register against risk ids found in suite files |
| `D5.negative-tests` | active tests whose title or body indicates a negative case (rejection, invalid input, error status, `toThrow`) or a boundary case (limit, empty, zero, maximum), as `negative` and `boundary` lists of `file:line` plus `of` active tests; a test may be in both. **Inferential**: a keyword is not proof the test exercises the case, and a missing keyword is not proof it does not. Per test, `negativeSignal` and `boundarySignal` | title vocabulary (English and Spanish, accent-insensitive) and masked-body assertion shapes; both live in `NEGATIVE_VOCABULARY` in `src/extract-source.js`, echoed in the item's `vocabulary` field |

**Discriminates:** 0 vs 1 from `D5.covered-rules`, with `D5.negative-tests` as
the signal for the rubric's negative-case wording (inferential: the agent reads
the listed tests before relying on it; no count is a threshold). 2 vs 3 from whether `D5.uncovered-rules` is computable at
all - level 3 requires the exclusions to be listed, which requires the catalogue.

**Left to judgment:** whether an uncovered rule is a deliberate exclusion or an
oversight. The repository rarely says.

---

## D6 - Life in CI

> Ceiling 1. Levels 2 and 3 are enforcement facts held by the CI platform.

| Item | Measures | Extraction |
|---|---|---|
| `D6.pipeline-present` | pipeline or workflow definitions that run the suite | scan `.github/workflows`, `azure-pipelines*.yml`, `**/pipelines/*.yml` |
| `D6.pipeline-triggers` | declared triggers: push, PR, schedule, manual | parse trigger blocks |
| `D6.suite-invocation` | the pipeline actually invokes the resolved suite. Settles `D6.runs-the-suite`, so a miss is a settled, wrong 0 | a command line under a command key (`script`, `before_script`, `after_script`, `run`, `bash`, `pwsh`, `command`, ...; the value may be a scalar, a block or folded scalar, or a list of such items as in GitLab; `bash -c "..."` style wrappers are unwrapped) runs the runner when it is a direct `playwright test` call, or an `npm test`, `npm run X`, `yarn X`, `yarn run X`, `pnpm X` or `pnpm run X` whose script in the nearest package.json expands to `playwright test` (one level); the pipeline must also name a resolved suite directory. Uses the same invocation finder as `D6.run-scope`. Conservative rule: an `npm test` or `npm run test...` whose script cannot be resolved (no package.json, or no such script) keeps counting, as it did before scripts were read; a script that resolves to something else (`jest`, `vitest`) does not count; an unresolved `yarn`/`pnpm` script was never counted and still is not |
| `D6.run-scope` | per running pipeline, each runner invocation with its raw line and the filters it passes (`--grep`, `--grep-invert`, `--project`, `--shard`, `--tag`, `--last-failed`, `--only-changed`, positional paths): `full` only when none is present. `--config` is recorded with `filtering: false`. Evidence for the judge and the report; it feeds no threshold. A filter whose value is a pipeline variable (`$(VAR)`, `${{ ... }}`, `$VAR`) is kept raw and marked `variable: true`: the effective scope is then unknowable from the repository | read run steps, folded and multi-line blocks and continuations; follow `npm`/`yarn`/`pnpm` scripts of the nearest package.json one level (`via: 'package-script'`) |
| `D6.result-publication` | test results published as a CI artifact | parse publish steps |
| `D6.declared-gating` | any in-repo claim of gating, such as a branch policy file | scan, flagged as declaration not enforcement |

**Discriminates:** 0 vs 1 only.

**Not scored, declared unreachable:** 2 and 3. A pipeline that declares a PR
trigger states an intention; whether the merge is blocked is a server-side
policy. Scoring intention as enforcement is the precise error this ceiling
exists to prevent.

---

## D7 - Maintainability

> Ceiling 2. Level 3 needs review and retirement process evidence.

| Item | Measures | Extraction |
|---|---|---|
| `D7.selector-mix` | semantic (`getByRole`, `getByLabel`, `getByTestId`) vs raw string locators | regex, reported as a ratio |
| `D7.file-size` | lines and test count per file | count |
| `D7.page-object-usage` | share of tests built on a layer (page object, fixture, helper) vs tests that call `page.`/`request.` inline; layer files by kind; `test.extend` declarations | inferential: one-level import graph over masked source. Layer files are relative imports of suite test files that resolve to a repository file (`.ts .js .mjs .cjs .tsx`, `/index.*`) and are not tests; kind is `pageObject` (class taking or storing `page`, or a page/screen/component-named class), `fixture` (`.extend(` on `test`/`base`) or `helper`. A test is layered when it calls an imported layer symbol, an instance of one, a destructured custom fixture, or an assertion proxy. Blind spots: tsconfig path aliases (`@pages/...`) and baseUrl imports are not resolved and are counted in `layers.unresolvedImports`, as are relative imports that resolve to nothing or into `node_modules`/build output; only direct imports of test files are followed; quoted fixture keys and data-only fixtures are missed. Read `unresolvedImports` before trusting the share. |

**Discriminates:** 0 vs 1 vs 2 from `D7.selector-mix` and `D7.file-size`.
`D7.page-object-usage` is evidence for the judge, with no threshold and no
bound attached. The rubric also weighs duplication; it is not extracted yet
(`D7.duplication`), so it is not enforced.

**Not scored, declared unreachable:** 3, unless the repository carries explicit
review and retirement process evidence (CODEOWNERS covering the suite, a
documented retirement policy). Commit history is in-repo and may support this
later; v1 does not read it.

---

## Not extracted in v1

Items the rubric or an earlier draft of this catalogue names, which no script
emits. They are not citable: the validator rejects them as `fabricated-item`.
They stay listed so the gap is visible and so a future extractor has a name and
a definition waiting. Moving one into a dimension table is part of the change
that makes the extractor emit it.

| Item | Would measure | Why not extracted |
|---|---|---|
| `D1.assert-literals` | expected values that are hardcoded literals vs derived from fixtures | needs an expression-level parse of `expect(...)` arguments; the extractor is a masked-text scanner |
| `D3.committed-run-artifacts` | run reports versioned in-repo that would let flakiness be measured | no committed-report scan exists |
| `D3.order-coupling` | tests referencing state produced by a previous test in the file | needs data-flow reading; at best an inferential heuristic, not attempted |
| `D3.shared-state` | module-level mutable bindings in test files | needs scope tracking outside test bodies; not written |
| `D4.title-quality` | test titles that name a behavior vs a mechanism | a classification of meaning, which is judgment and belongs to the agent, not a script |
| `D7.dead-markers` | long-lived `skip`, `fixme`, `BLOCKED` or `TODO` annotations | "long-lived" needs commit history, which v1 does not read |
| `D7.duplication` | repeated statement sequences across test files | normalized token-window comparison not written |
| `D7.title-vocabulary` | titles naming implementation (button, click, modal) vs domain terms | a classification of meaning, which is judgment and belongs to the agent |

---

## Calibration baseline

A threshold without a distribution behind it is a magic number. This is the
spread the thresholds in `src/thresholds.json` were placed against: five suites
in production use, measured over the resolved suite boundary. Repositories whose
whole suite is an unmodified scaffold are excluded, since a one-test suite
carries no signal to calibrate on.

| Signal | Low | Median | High |
|---|---:|---:|---:|
| Test files | 13 | 22 | 69 |
| Tests | 58 | 79 | 585 |
| Assertions per active test | 1.92 | 2.64 | 3.14 |
| Share of tests carrying a case id | 0% | 76.7% | 100% |
| Assertless share of active tests | 0% | 0.2% | 5.6% |
| Rendering-only share of active tests | 0% | 17.3% | 20.4% |
| Fixed waits per test | 0 | 0.16 | 1.83 |
| Skipped share | 0% | 3.8% | 20.6% |
| Semantic selector share | 0.6% | 26.1% | 54.3% |
| `getByTestId` uses | 0 | 0 | 0 |

Read it against the thresholds and each line either earns its place or does not.
The assertless limit of 5% sits above a cluster running from 0% to 0.6% and
below a single suite at 5.6%, so it separates an outlier rather than splitting a
population. The fixed-wait limit of 1.0 per test does the same. The semantic
selector limit of 10% has the weakest support here: the observed spread runs
from 0.6% to 54.3% with nothing clustered near the line, so that one is a
judgement about what good looks like more than a reading of these suites.

### Why this is a shape and not a table of repositories

An earlier version listed each repository by name with its own column. That was
wrong twice over.

It attributed internal quality metrics to named systems, which is not this
document's to publish. Renaming the columns would not have fixed it: a row of
counts is a fingerprint, and anyone with access to the repositories can map
"69 files, 585 tests" back to its origin immediately.

And it rotted. It was typed by hand from a snapshot, and the instrument that
produced those numbers has since been corrected three times - assertion proxies,
parked tests, and `test.fail` declarations were all being miscounted. One figure
in it was off by a factor of thirty. A document that states measured facts about
live systems and is not regenerated does not go stale quietly; it keeps asserting
with the same confidence while drifting further from the truth.

A range survives small drift where an exact count cannot, and the per-repository
detail already lives in the evidence artifacts, which are generated on demand and
never committed.
