# LogicModel v1: proposal from Role 5 (compiler) for Role 4 (schema owner)

**Status: draft for discussion at Gate A. Not agreed. Role 4 owns the schema; nothing in `packages/schema` has been changed.**

The compiler (`packages/compiler`, version 0.1.0) already accepts exactly this shape as a **provisional** input, so the team has a working end-to-end path while the shared schema is agreed:

- TypeScript types: `../src/logic-model.ts`
- Complete example: `../test/fixtures/child-cough.logic.json`, which is a technical demonstration and **not clinician-approved logic**
- Every rejection rule: `../src/compile.ts` and `../src/xpath.ts`, error codes in `../src/errors.ts`

When Role 4 publishes `packages/schema`, the compiler switches to those types, and any difference becomes a compile change, not a schema change.

## What the compiler needs from the model

1. **Conditions as trees, never as expression strings.** The compiler turns trees into XPath with every compound subexpression bracketed, so a dropped bracket cannot happen. cht-conf's offline checks do not parse XPath: an unbalanced expression passed conversion in our test (`../reference/child-cough/README.md`, Negative 2).
2. **A small, closed set of constructs.** Anything outside it is a compile error with a code, never a guess. Unknown fields are errors too, so nothing a drafter adds is silently dropped.
3. **Stable ids.** Ids become XLSForm field names. Renaming a field on a deployed form breaks existing reports (Vision Document: "Renaming a field on a deployed form is blocked").
4. **Agreed meaning of "unanswered".** The evaluator (Role 4) and the compiled form must give the same answer for the same input, including partly filled forms. This is the most important point to agree.

## Shape

Top level: `schemaVersion` (`"1.0"`), `pathwayId`, `title`, `language` (`"en"` only), `sources`, `context`, optional `applicability`, optional `pages`, `questions`, `derived`, `decisionTables` (exactly one), `outcomes`, `ambiguities`.

| Part | Fields | Notes |
|---|---|---|
| `sources[]` | `id`, `title`, `sha256?`, `url?` | Every `source` / `sourceRef` must name one of these |
| `context[]` | `id`, `type: "integer"`, `from: "contact.age_in_months"` | Only this one context value in v1; compiled from the contact's date of birth |
| `applicability` | `when` (context values only), `notApplicableOutcome`, `unknownOutcome`, `source?` | Out-of-range and unknown age each lead to a named outcome, so neither is silent |
| `pages[]` | `id`, `label` | Optional. If given, every question names its page; if not, all questions go on one page |
| `questions[]` | `id`, `type`, `label`, `hint?`, `page?`, `options?`, `min?`, `max?`, `relevantWhen?`, `source?` | `type`: `boolean`, `integer`, `decimal`, `select_one`. All are required when relevant. `relevantWhen` may use context values and **earlier** questions only |
| `derived[]` | `id`, `type: "boolean"`, `when`, `source?` | May use context values, questions and earlier derived values |
| `decisionTables[0]` | `id`, `hitPolicy` (`unique` or `first`), `rows[]` of `{ when, outcome, source? }`, `otherwise` | `otherwise` is mandatory. Its id becomes the classification field |
| `outcomes[]` | `id`, `label`, `referral` (`urgent` or `none`), `followUp?: { afterDays }`, `message?` | Every outcome must be produced by some row, `otherwise` or applicability |
| `ambiguities[]` | `id`, `text`, `status` (`open` or `resolved`), `blocking`, `sourceRef?`, `resolution?` | Open and blocking stops compilation |

Display text (labels, hints, messages) must not contain `${`, `<`, `>` or control characters.

## Condition nodes

All operands are ids; the right-hand side is always a literal.

| Node | Applies to | "Definitely true" XPath the compiler emits |
|---|---|---|
| `{ "and": [c, …] }`, `{ "or": [c, …] }` | conditions | `(c1 and c2 …)`, `(c1 or c2 …)` |
| `{ "not": c }` | condition | swaps true and false |
| `{ "eq" / "neq": [id, true/false] }` | boolean question | `selected(${id}, 'yes')` |
| `{ "eq" / "neq": [id, true/false] }` | derived value | `${id} = 'yes'` |
| `{ "eq" / "neq": [id, "option"] }` | select_one | `selected(${id}, 'option')` |
| `{ "eq" / "neq" / "lt" / "lte" / "gt" / "gte": [id, number] }` | integer, decimal, context | `(${id} != '' and ${id} >= 50)` |
| `{ "answered": id }` | question or context | `${id} != ''` |

## Semantics for unanswered values (needs agreement)

- The compiler emits two expressions per condition: "definitely true" and "definitely false". A value that is not answered makes both false, so the condition is **unknown**.
- `and` is false if any part is false; `or` is true if any part is true; otherwise unknown. This is three-valued (Kleene) logic.
- A derived value is a calculate holding `'yes'`, `'no'` or `''` (unknown).
- A decision row matches only when its condition is **definitely true**. Rows are tried in order; if none match, the result is `otherwise`.
- Role 4's evaluator should follow the same rules. The shared fixture is `fixtures/child-cough/logic.json` (same bytes as `../test/fixtures/child-cough.logic.json`). `fixtures/child-cough/golden-cases.json` gives the expected report values, including two partly answered forms (`incomplete-breaths-missing`, `incomplete-cough-unanswered`). Those expectations are technical and not clinician-approved.

## Changes since the first draft

- Added `pages` and `question.page`, `question.hint`.
- `applicability` now names `notApplicableOutcome` and `unknownOutcome` instead of leaving those cases to the compiler.
- Outcomes now need a `label`.
- `select_multiple` is out of v1.
- Exactly one decision table in v1.
- The `ID_CHANGED_FROM_BASELINE` check is **not implemented yet**: it needs the deployed baseline's field ids (question 6 below).

## Questions for Role 4

1. Do you agree to condition trees instead of expression strings?
2. Do you agree to the three-valued rule for unanswered values?
3. `hitPolicy: "unique"` with a checker proof, or `"first"`? The compiler tries rows in order either way; under `unique` the order does not matter only if your checker proves the rows do not overlap.
4. Where do source citations and ambiguities live: in the model, as above, or in a separate document keyed by id?
5. Which language is the schema in? The scaffold has `packages/schema/src/*.ts` and `logic-model.schema.json`, while the `logic-model` branch has a `schema.py`. A JSON Schema file plus generated TypeScript types would serve both.
6. Who supplies the deployed baseline's field ids for the renamed-field check: Role 2 or the compiler, by reading the baseline form?
