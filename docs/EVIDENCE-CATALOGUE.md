# Evidence Catalogue - v1

Scope: **repository evidence only**. No CI API, no run history, no branch policies.

This catalogue defines what the scripts extract. It does not assign scores.

## Contract

```
scripts  ->  evidence items  (deterministic, diffable, no judgment)
agent    ->  rubric level    (judgment, must cite item ids)
```

An agent that gathers and judges in the same step produces a score that cannot
be diffed across runs: when the number moves, nobody can tell whether the suite
changed or the model did. Every level assignment must name the evidence items
that support it, and an item the scripts did not produce cannot support a level.

Item ids are stable: `D<dimension>.<slug>`. They are the vocabulary the agent
prompt and the report both speak.

## Ceilings

A level the repository cannot witness is not scored. It is declared unreachable.

| # | Dimension | Ceiling | Binding constraint |
|---|---|---|---|
| 1 | Oracle | 3 | needs a rule inventory in-repo (drops to 1 without one) |
| 2 | Sensitivity | 3 | level 3 needs mutation evidence committed |
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

## D1 - Oracle

> Where does "correct" come from.

| Item | Measures | Extraction |
|---|---|---|
| `D1.test-inventory` | every test: file, title, line | parse `test(...)` / `test.describe(...)` |
| `D1.tc-id-coverage` | tests whose title carries a case id (`TC-XXX-000`) | regex over titles |
| `D1.ext-id-coverage` | tests whose title carries an external work item id (`[27499]`) | regex over titles |
| `D1.rule-inventory` | rule documents present and rule ids declared | scan `01-specifications/**/01-business-rules.md` or equivalent |
| `D1.spec-linkage` | case ids in tests that resolve to a documented case or rule | join `D1.tc-id-coverage` against `D1.rule-inventory` |
| `D1.assert-literals` | expected values that are hardcoded literals vs derived from fixtures | AST-ish scan of `expect(...)` arguments |

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
| `D2.mutation-config` | mutation testing configured (Stryker et al.) | dependency and config file scan |
| `D2.soft-assertions` | `expect.soft` usage, which downgrades failure to warning | regex |

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

**Discriminates:** level 0 mechanically, from `D2.assertless-tests` plus
`D2.weak-assertions`. Level 3 requires `D2.mutation-config` to be non-empty.

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
| `D3.retries-config` | configured retries, CI and local | config read |
| `D3.serial-mode` | `describe.serial`, `fullyParallel: false`, `workers: 1` | config and source read |
| `D3.shared-state` | module-level mutable bindings in test files | scan for `let`/`var` outside test bodies |
| `D3.order-coupling` | tests referencing state produced by a previous test in the file | heuristic, flagged as inferential |
| `D3.committed-run-artifacts` | run reports versioned in-repo that would let flakiness be measured | look for committed JSON or JUnit reports |

**Discriminates:** 0 vs 1 vs 2. `D3.retries-config` above zero plus
`D3.fixed-waits` above zero is strong evidence against level 2. Level 2 requires
`D3.committed-run-artifacts` to exist: "measured" needs a measurement.

**Left to judgment:** whether retries are a load-tolerance decision or a flake
suppressor. Configs sometimes explain themselves in comments; the agent reads them.

---

## D4 - Diagnosis

> What it tells you when it fails.

| Item | Measures | Extraction |
|---|---|---|
| `D4.trace-config` | `trace`, `screenshot`, `video` settings | config read |
| `D4.reporter-config` | reporters configured, HTML or external | config read |
| `D4.title-quality` | test titles that name a behavior vs a mechanism | title corpus, classified by the agent |
| `D4.failure-context` | custom messages on assertions, `test.step` usage, annotations | regex |
| `D4.artifact-retention` | whether artifacts survive the run (`outputDir`, CI publish step) | config and pipeline read |

**Discriminates:** 0 vs 1 vs 2 mechanically from `D4.trace-config` and
`D4.failure-context`.

**Left to judgment:** 2 vs 3 - whether the report names the broken business rule
without opening code. That is a reading of `D4.title-quality` against
`D1.rule-inventory`, not a count.

---

## D5 - Business rule coverage

> Needs a rule inventory. Ceiling 1 without one.

| Item | Measures | Extraction |
|---|---|---|
| `D5.rule-catalogue` | rules declared in specs, with ids | parse rule documents |
| `D5.covered-rules` | rules with at least one test linked via case id | join with `D1.spec-linkage` |
| `D5.uncovered-rules` | declared rules with no linked test | set difference |
| `D5.orphan-tests` | tests whose case id resolves to no declared rule | set difference, other direction |
| `D5.negative-tests` | tests whose title or body indicates a negative or boundary case | keyword and assertion-shape scan |
| `D5.priority-distribution` | tests by declared priority tag (`@P0`, `[P1]`) | regex over titles |
| `D5.skip-ratio` | skipped share of the suite | from `D2.skipped-tests` |

**Discriminates:** 0 vs 1 from `D5.negative-tests`. 2 vs 3 from whether
`D5.uncovered-rules` is computable at all - level 3 requires the exclusions to be
listed, which requires the catalogue.

**Left to judgment:** whether an uncovered rule is a deliberate exclusion or an
oversight. The repository rarely says.

---

## D6 - Life in CI

> Ceiling 1. Levels 2 and 3 are enforcement facts held by the CI platform.

| Item | Measures | Extraction |
|---|---|---|
| `D6.pipeline-present` | pipeline or workflow definitions that run the suite | scan `.github/workflows`, `azure-pipelines*.yml`, `**/pipelines/*.yml` |
| `D6.pipeline-triggers` | declared triggers: push, PR, schedule, manual | parse trigger blocks |
| `D6.suite-invocation` | the pipeline actually invokes the resolved suite | match run steps against suite paths |
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
| `D7.duplication` | repeated statement sequences across test files | normalized token windows |
| `D7.page-object-usage` | whether interaction is layered or inline in tests | import graph of test files |
| `D7.file-size` | lines and test count per file | count |
| `D7.title-vocabulary` | titles naming implementation (button, click, modal) vs domain terms | classified by the agent |
| `D7.dead-markers` | long-lived `skip`, `fixme`, `BLOCKED` or `TODO` annotations | regex |

**Discriminates:** 0 vs 1 vs 2 from `D7.selector-mix`, `D7.duplication` and
`D7.page-object-usage`.

**Not scored, declared unreachable:** 3, unless the repository carries explicit
review and retirement process evidence (CODEOWNERS covering the suite, a
documented retirement policy). Commit history is in-repo and may support this
later; v1 does not read it.

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
