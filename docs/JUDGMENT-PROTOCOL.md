# Judgment Protocol - v1

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
  v1 reads only the repository. The total is reported as obtained over
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
  "schema": "verdict/v1",
  "repo": "<from input>",
  "evidenceDigest": "<copied verbatim from input>",
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
