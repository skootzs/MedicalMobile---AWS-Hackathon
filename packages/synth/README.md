# Synthetic patients and coverage

This package generates reproducible fictional inputs for the [verification suite](../verification/README.md). [logic-model.ts](src/logic-model.ts) reads numeric boundaries from a LogicModel and generates cases around them. [patients.ts](src/patients.ts) builds inputs from configured threshold data, including missing-value and danger-sign cases.

[coverage.ts](src/coverage.ts) compares observed branch IDs against the expected branch inventory and reports gaps. [expected.ts](src/expected.ts) loads golden-case expectations supplied separately from generation. Generated inputs exercise the pathway. Independently authored golden cases supply expected clinical outcomes.

Run `npm run build -w packages/synth` from the repository root. The [verification guide](../verification/README.md#run) shows how to pass cases to the verifier.

## Generate inputs from a fixture

From the repository root, compile the package, then pass a model and an output path. Choose a new output file to keep the checked-in sample patients intact.

```sh
npm run build -w packages/synth
LOGIC_MODEL_FILE=fixtures/child-cough/logic.json node packages/synth/dist/write-patients.js /tmp/cht-child-cough-patients.json
```

The writer uses `LOGIC_MODEL_FILE`, then `/in/logic.json` if it exists. If neither supplies an existing file, the writer warns and uses the unconfirmed [sample thresholds](data/thresholds.json) and [branch definitions](data/branches.json). It reports the case count on stderr. The model-driven generator tries values below, at, and above integer boundaries. It also generates boolean alternatives and unanswered cases for required visible fields.

## Read coverage

Pass the branch IDs observed by the harness and the expected branch inventory to `computeCoverage`. Use gaps to identify inputs or branches that still need exercise. Keep case coverage separate from outcome agreement. A generated input can cover a branch without carrying a clinician-authored expectation.
