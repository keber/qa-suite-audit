# Judgment Protocol (verdict schema `verdict/v2`)

The rubric you are applying is by Adriana Troche Robles, published on Calidad
sin Humo:
https://calidadsinhumo.com/guias/rubrica-para-juzgar-una-suite-de-tests/

Read it before judging anything. This protocol governs how a level is recorded
and what it must cite; it does not restate what each level means, and a level
assigned without having read its definition is a guess with a citation attached.

Input: the output of `judge-prep.js` for one repository.
Output: one verdict object, shape below.

You assign levels. You do not gather evidence. If a fact you want is not in the
input, you do not have it, and the honest move is to say so rather than to look
for it.

## Step 0 - What kind of suite is this

Before any level, say what kind of suite you are reading. The right way to read
a test depends on it, and a judge who decides silently produces notes nobody can
compare across runs. Choose one `suiteType`:

- `regression` - the expected values come from the specification. A failing test
  means the system drifted from what it is meant to do.
- `defect-harness` - the suite asserts known defects on purpose. Its expected
  values come from a defect report, and a test may be written to pass while the
  defect still exists.
- `characterization` - the suite freezes what the system does today, whether or
  not that is right. A failing test means behaviour changed, not that it broke.
- `mixed` - different directories are different kinds. Give a `byDirectory`
  entry for every group in the signals, each one of the three types above and
  never `mixed`.

The input gives you signals, not an answer: `D0.suite-type-signals` counts, per
suite and per top-level test directory, the defect ids in titles and file names,
declared expected failures, snapshot assertions, and the case ids that link to a
declared rule. Each group carries a `key`; use it verbatim in `byDirectory`.
Read tests from each directory before you decide, because a count can be
misleading (a title may name a defect that it merely regression-tests).

The validator rejects a `suiteType` for any of these reasons:

- It is absent (`suite-type-missing`), or `type` is not one of the four values
  (`suite-type-invalid`).
- It does not cite `D0.suite-type-signals` (`suite-type-uncited`). Every item it
  cites must exist in the input, so an invented id is a `fabricated-item`.
- Its `reasoning` is shorter than the minimum a level needs (40 characters),
  reported as `thin-reasoning`.
- `type` is `mixed` and `byDirectory` is missing, leaves out any group key in the
  signals, names a key the signals do not have, or gives a value other than
  `regression`, `defect-harness` or `characterization` (`suite-type-mixed-breakdown`).
- `type` is not `mixed` and `byDirectory` is present at all
  (`suite-type-mixed-breakdown`): only a mixed suite has a breakdown.

If the input has no `D0.suite-type-signals` at all, it was generated before step 0
existed. The validator reports `evidence-outdated`; regenerate the evidence and
judge again.

What it changes: how you read D1 and D5. The oracle of a defect harness comes
from the defect report rather than from a rule catalogue, and a characterization
suite is not expected to cover rules it never claimed to protect. Say so in the
reasoning of those dimensions.

What it does not change: any bound. In this release of the tool the suite type
moves no ceiling, cap or floor, and nothing in the total or the elimination rule
reads it. Whether it should is an open question, tracked in issue #10, because a
bound that the judge can raise by declaring something is not a bound.

## What you are allowed to decide

`judge-prep.js` has already applied every boundary the evidence settles. For
each dimension it gives you:

- `bounds: { min, max }` - the range you may choose inside. Nothing outside it.
- `determined` - when set, the level is already fixed. Do not revisit it.
- `constraints` - which threshold narrowed the range, and what it observed.
- `question` - the one thing the evidence cannot answer.
- `mustCite` - the item ids your answer has to reference.

A dimension with `determined` set is closed. Restating its reasoning is fine;
changing its number is not.

## How to answer an open dimension

1. Read `question`. It names the one thing you cannot get from counts.
2. Read the items in `mustCite` from the `items` block.
3. Read actual test code where the question requires it. The evidence gives you
   file and line for every test it names; open those.
4. Choose a level inside `bounds`.
5. Write two to four sentences of reasoning that reference at least one item id
   and at least one concrete observation from the code you read.

If you cannot answer the question because the input does not contain what you
need, assign the lowest level the bounds permit and set `confidence` to `low`
with a reason. Never guess upward. A level you cannot support is worse than a
level that is too cautious, because nobody can tell the difference later.

## Citation rules

- Every level cites at least one item id from `mustCite`.
- An item id you cite must exist in the `items` block. Do not invent ids.
- A claim about a specific test cites `file:line` as the evidence prints it.
- Do not cite a count you did not read. If you say "most tests", the item you
  cite must actually support "most".

## Things that are not yours to do

- Do not apply the source rubric's verdict bands. They assume complete evidence;
  this release of the tool reads only the repository. The total is reported as obtained over
  attainable, nothing more.
- Do not compensate. A dimension capped by a threshold stays capped even if the
  suite is excellent elsewhere.
- Do not soften an eliminatory result. If D1 or D2 lands at 0, the suite does not
  pass, and the report says so plainly.
- Do not move a threshold. If one looks wrong, say which, in
  `thresholdObjections`, and leave the number alone. That file is the argument
  surface; editing it mid-audit destroys comparability with every prior run.

## Verdict shape

```json
{
  "schema": "verdict/v2",
  "repo": "<from input>",
  "evidenceDigest": "<copied verbatim from input>",
  "suiteType": {
    "type": "mixed",
    "byDirectory": { "./api": "regression", "./legacy": "defect-harness" },
    "citations": ["D0.suite-type-signals"],
    "reasoning": "Two to four sentences."
  },
  "levels": [
    {
      "dimension": 1,
      "level": 2,
      "confidence": "high | medium | low",
      "citations": ["D1.spec-linkage", "D5.covered-rules"],
      "observations": ["qa/07-automation/e2e/tests/adm/contratos.spec.ts:44"],
      "reasoning": "Two to four sentences."
    }
  ],
  "obtained": 11,
  "attainable": 16,
  "eliminated": false,
  "eliminatedBy": [],
  "thresholdObjections": [],
  "notes": "Anything the reader needs that the numbers do not carry."
}
```

The example declares `mixed` so the breakdown is visible. For `regression`,
`defect-harness` or `characterization`, write `type`, `citations` and `reasoning`
only, with no `byDirectory`. Its keys are the `key` values of the groups in
`D0.suite-type-signals`, one per group and none extra.

`verdict/v1` verdicts predate suite type. They are rejected, not migrated: a
suite type added afterwards would be a classification nobody made against the
evidence, so the suite is re-judged.

`evidenceDigest` is copied from the input without modification. It binds this
verdict to that exact evidence. A verdict whose digest does not match the
evidence it is read against is stale, and is to be discarded rather than
adjusted.

## Reporting the result

State the total as `obtained / attainable`. Name the ceilings that applied and
why. When a calibrated threshold decided an outcome, say so in `notes` - a
reader is entitled to know when a number came from a judgement call about where
to draw a line rather than from the rubric text.

Borderline cases deserve explicit mention. A suite that lands just past a
calibrated threshold is not the same as one that lands far past it, and the
report should not make them look identical.
