# Shared schemas

[LogicModel v1](src/logic-model.schema.json) defines the pathway document shared by drafting, checking, evaluation, and compilation. It covers source citations, applicability, questions, derived values, decision tables, outcomes, and ambiguities. The [golden-case schema](src/golden-cases.schema.json) defines the synthetic inputs and independently authored expected outcomes used to check it.

- [validate.ts](src/validate.ts) exposes Ajv validators that return structured errors with paths. Shape validation is the first check. [Checker](../checker/README.md) handles semantic checks and case agreement.
- [types.ts](src/types.ts) and [patch.ts](src/patch.ts) describe shared types and proposed snapshot edits.
- [handoffs.ts](src/handoffs.ts) defines versioned compile and verify job contracts shared by the orchestrator and build runner.

Run `npm test -w packages/schema` from the repository root.

## Validate a document

Use `readJson` to load an unknown value, then call `validateLogicModel` or `validateGoldenCases`. The result is either `{ ok: true }` or `{ ok: false, errors }`. Each error includes an instance path and a message. A root-level error uses `$` as the path. Parsing invalid JSON throws before validation.

| Contract | What to inspect |
| --- | --- |
| LogicModel | Stable IDs connect fields, conditions, outcomes, and citations. A semantic check follows schema validation to verify references and behavior. |
| Golden cases | Each case supplies an ID, an input map, and expected fields. Keep case expectations traceable to the guideline and authored independently from model output. |
| Job payloads | Compile and verify messages carry job and request IDs, input references, and digests. The worker validates the contract before taking a job. |

Use the [child-cough logic model](../../fixtures/child-cough/logic.json) and [golden cases](../../fixtures/child-cough/golden-cases.json) as examples. The [validator tests](test/validate.test.ts) cover accepted shapes and rejected inputs.
