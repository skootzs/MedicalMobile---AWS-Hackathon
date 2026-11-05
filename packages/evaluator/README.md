# Deterministic evaluator

[evaluateLogicModel](src/evaluate.ts) takes a pathway LogicModel and answers keyed by field ID. It resolves derived fields, checks applicability, and evaluates the first decision table. The first definitely true row determines the outcome. The result also records every matching row so the checker can detect overlaps. If no row matches, it uses the table's fallback.

[conditions.ts](src/conditions.ts) preserves true, false, and unknown so missing answers retain their own meaning. [domain.ts](src/domain.ts) builds boundary domains for the checker. `reportFields` converts the evaluation into the comparison fields used by golden cases, including classification, referral, and follow-up.

Run `npm test -w packages/evaluator` from the repository root. See [checker](../checker/README.md) for the golden-case gate and [verification](../verification/README.md) for checks against the compiled CHT project.

## Evaluation order

1. Supply answers keyed by the model's question or context IDs. Use booleans for yes/no questions, numbers for numeric answers, and option IDs for single-select questions. The evaluator rejects unknown input IDs.
2. Resolve derived fields in model order and check applicability. An unknown scope uses the model's `unknownOutcome`. A false scope uses its `notApplicableOutcome`.
3. For in-scope answers, evaluate each row and collect the indexes of rows whose conditions are definitely true. Return the winning classification, referral flag, follow-up days, and derived values.

Use `reportFields` when comparing results to golden-case JSON. It maps the result to keys such as `classification`, `in_scope`, and `follow_up_days`. The [golden-case tests](test/golden.test.ts) show how to call the evaluator with a fixture. The [schedule helper](src/schedules.ts) also exposes the configured follow-up days by outcome ID.
