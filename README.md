# @keber/qa-suite-audit

Repeatable, evidence-first audit of an automated test suite.

Scripts produce evidence. An agent assigns rubric levels citing that evidence. A
validator checks the verdict. The three stay separate on purpose: a score that
cannot be traced back to something a machine measured is an opinion with a
number attached, and it stops being comparable the moment anything changes.

## The rubric is not mine

This tool implements someone else's thinking. The seven dimensions it scores -
Oracle, Sensitivity, Determinism, Diagnosis, Business rule coverage, Life in CI,
Maintainability - their level definitions, the 0 to 3 scale, the verdict bands
and the two eliminatory dimensions all come from:

> **[Como saber si tus tests automatizados sirven: la rubrica de 7 criterios para auditar una suite](https://calidadsinhumo.com/guias/rubrica-para-juzgar-una-suite-de-tests/)**
> by **Adriana Troche Robles**, published 18 August 2026 on
> [Calidad sin Humo](https://calidadsinhumo.com/).

She also publishes an [interactive self-assessment](https://calidadsinhumo.com/recursos/cuanto-saca-tu-suite/)
built on the same rubric, which is the fastest way to see what it asks before
reading any of this code.

What this repository adds is narrow and mechanical: a way to gather the evidence
a rubric level should cite, bounds that stop a level being assigned past what the
evidence supports, and a validator that refuses a verdict which does not match
the evidence it claims to read. The judgement the rubric asks for is still a
person's, or an agent's, to make.

The quoted rubric text in `src/thresholds.json` is reproduced for the purpose of
recording which sentence each threshold interprets. That text is the author's
work and is not covered by this repository's license.

## Scope of v1

**Repository evidence only.** No CI API, no run history, no branch policies.

That is a real limit and the instrument states it rather than working around it.
Two of the rubric's dimensions - Determinism and Life in CI - are the least
subjective of the seven and also the ones a repository cannot fully witness:
"flakiness is measured" needs a measurement, and "blocks the merge" lives in a
server-side policy. Scoring intent as enforcement is the error the ceilings exist
to prevent.

The source rubric has 21 points. v1 can reach **16**, or **13** in a repository
with no rule inventory. Results are reported as `obtained / attainable`, never
out of 21, and the source rubric's verdict bands are not applied because they
were calibrated for evidence this audit does not have.

## Install

```bash
npm install --save-dev @keber/qa-suite-audit
```

## Use

```bash
# 1. gather evidence and bound the judgment
npx qa-suite-audit evidence ./path/to/repo --out audit/input.json

# 2. an agent writes a verdict following docs/JUDGMENT-PROTOCOL.md
#    (this tool never writes one: it would have nothing left to check it against)

# 3. check the verdict against the evidence it claims to read
npx qa-suite-audit validate audit/input.json audit/verdict.json

# 4. render
npx qa-suite-audit report audit/input.json audit/verdict.json                      # terminal
npx qa-suite-audit report audit/input.json audit/verdict.json --format html --out audit/report.html
npx qa-suite-audit report audit/input.json audit/verdict.json --format allure --out allure-results
```

Where a ceiling or cap exists only because a person has to answer, the input
lists the exact question in `teamQuestions` and every report prints it under
"Questions for the team", marked `read by this release` or `for the reader`. The
judge never answers them. Only two are read by this release: a rule inventory
or a mutation config committed to the repository lifts its bound once the
evidence is extracted again. The rest are for whoever reads the report; the
bound stays where it is.

`report` refuses to render an invalid verdict. A report is a claim about a
suite; publishing one drawn from evidence that no longer matches would be worse
than publishing nothing.

## How it is put together

| Piece | Job |
|---|---|
| `src/resolve-suite.js` | which files are the suite, and by which rule each was decided |
| `src/extract-source.js` | per-test evidence: assertions, waits, selectors, skips |
| `src/extract-pipelines.js` | CI definitions, identified by content rather than by path |
| `src/extract-mutation.js` | mutation testing tooling (Stryker, mutmut, PIT, infection), identified by content and config names |
| `src/adapters/` | **the only methodology-specific code**: how rules and cases are written down |
| `src/suite-type.js` | `D0.suite-type-signals`: per-directory signals for step 0 (signals only; the verdict declares the type) |
| `src/traceability.js` | the rule-to-test join, identical for every adapter |
| `src/judge-prep.js` | applies the thresholds and bounds what is left to judge |
| `src/validate-verdict.js` | checks a verdict against its evidence |
| `src/report/` | terminal, HTML and Allure renderers over one shared model |
| `src/thresholds.json` | every interpretive decision, with the rubric text it reads |

### The boundary problem

Five separate directories of content that looks like the real thing turned up
while this was built: a vendored `node_modules` **inside** a test directory,
agent worktrees under `.claude`, a tracker cache holding 747 of one repository's
867 specification files, tooling page snapshots, and an application's i18n
resources. One repository reports 1801 YAML files, of which six are pipelines.

Name-based blacklists do not scale to that: they need a new entry for every tool
that writes a file. Artifacts are identified by **content** instead - a pipeline
is a file whose top level declares pipeline keys, a suite is what the runner
config says it is.

### Adapters

Everything outside `src/adapters/` is methodology-free. An adapter answers three
questions: does this project follow the convention, how does a test title carry
a case id, and where are the rules and cases written down.

`generic` always matches, so a project with no rule inventory is not a special
case. It is audited against the lower ceiling: the suite is not judged worse,
it is judged with less evidence available.

### Thresholds

Turning a prose level description into a boundary is a choice.
`src/thresholds.json` records each one with the rubric text it interprets,
whether it is a literal reading or a calibration, the rationale, and what moving
it costs in each direction. A test enforces that no threshold can exist without
those fields.

Every report names the dimensions a calibrated threshold decided. A reader is
entitled to know when a number came from a line somebody drew by hand.

## Requirements

Node 20 or newer. No runtime dependencies.

Suite reading currently understands Playwright. That is the deepest coupling in
the codebase and the real cost of supporting another runner.
