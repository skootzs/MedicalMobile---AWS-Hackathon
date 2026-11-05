# Logic checker

[checkLogicModel](src/check.ts) takes a candidate LogicModel and optional golden cases. It validates both documents against the shared schemas, checks IDs and references, flags unresolved blocking ambiguities, and compares case outcomes using the deterministic [evaluator](../evaluator/README.md). It also samples combinations around input boundaries to look for overlapping decision rows. The report records analysis limits when coverage is incomplete.

The report contains a `PASS` or `FAIL` outcome and findings with severity, blocking status, and references. Golden cases use expected outcomes derived from the guideline. A passing checker report is evidence for human content review.

From the repository root, use the CLI or run the checker tests.

```sh
npm run check -w packages/checker -- /path/to/logic-model.json --golden /path/to/golden-cases.json
npm test -w packages/checker
```

The CLI writes JSON to stdout. Exit status is 0 for a pass, 1 for a failed check, and 2 for a usage or input-read error.

## Run the child-cough example

The CLI resolves file arguments from the checker workspace. Run this command from the repository root.

```sh
npm run check -w packages/checker -- ../../fixtures/child-cough/logic.json --golden ../../fixtures/child-cough/golden-cases.json
```

## Interpret the findings

| Finding | Where to look |
| --- | --- |
| `SCHEMA` or `GOLDEN_SCHEMA` | Use the reported path to locate a missing field or invalid value in the model or case file. |
| `DUPLICATE_ID` or `UNKNOWN_REFERENCE` | Check the ID and the order in which the question or derived field becomes available. |
| `GOLDEN_MISMATCH` | Compare the evaluator's reported fields to the independently authored expectation and cited guideline. |
| `OVERLAP` | Inspect the reported input and row indexes. Under the unique hit policy this blocks the check. Under the first-match policy the first row wins and the overlap is informational. |
| `ANALYSIS_LIMIT` | The boundary search was skipped because the combination count fell outside the search limit. |

The overlap search includes numeric boundary points and unanswered values. It caps the search at 50,000 combinations, so a pass reflects the combinations examined. The [checker tests](test/check.test.ts) exercise the child-cough fixture and invalid model variants.
