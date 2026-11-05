# @cht-nocode/verification

Synthetic-patient verification for compiled CHT configuration. The runner takes
a built CHT project, drives its forms and tasks through
[`cht-conf-test-harness`](https://www.npmjs.com/package/cht-conf-test-harness)
against a fixed set of synthetic patients, records the observed outcomes, and
writes a structured `VerificationReport` (`report.json`) plus a
`verification.log`.

Expected outcomes come from two independent, non-model sources: **golden cases**
(technical fixtures) and **R4's Python evaluator** run over an approved logic
model. The two are compared against the harness's actual output and against each
other; any disagreement, error, uncovered branch, or failed integrity check
makes `passed` false. **There are no model/LLM calls anywhere in this package.**

- Package name: `@cht-nocode/verification`
- Entry point (container): `node /verifier/dist/run.js`
- Schema export: `@cht-nocode/verification/schema` → bundled
  `verification-report.schema.json`

---

## Follow one verification run

1. Resolve the compiled project, logic, and optional golden-case file. [hashing.ts](src/hashing.ts) checks the inputs and compile artifact against the digests supplied by the runner.
2. [patient-mapper.ts](src/patient-mapper.ts) maps synthetic patient fields to form pages. [case-executor.ts](src/case-executor.ts) drives the harness and records observed form fields, tasks, and branches.
3. [evaluator-bridge.ts](src/evaluator-bridge.ts) obtains expected values from the Python evaluator when configured. The report also retains any golden expectations so disagreements can be traced to their source.
4. [report-builder.ts](src/report-builder.ts) assembles case results, coverage, and integrity checks. The job runner validates the resulting report and binds it to the build being verified.

For a failed run, open [the report field guide](#report-field-semantics-for-r2) and check integrity and case outcomes before investigating coverage gaps. Use `verification.log` for harness or Python errors. A process exit of 1 can still produce a valid report for review.

## Directory layout

```
verification/
├── src/                  TypeScript source (compiled to dist/)
├── python/               Python bridge to R4's evaluator
├── scripts/              Test selector (quick vs slow suites)
├── test/                 node:test suites + fixtures
├── vendor/               Vendored copy of R4's evaluator (unpinned)
├── docs/                 Sample report for reference
├── dist/                 Build output (tsc + bundled assets)  [generated]
├── dist-test/            Compiled tests                        [generated]
├── package.json          Scripts, deps, exports
├── tsconfig.json         Build config (src → dist)
└── tsconfig.test.json    Test build config (src + test → dist-test)
```

### `src/` — runner and library modules

Everything is plain ES2022 for Node 20/22 (`module: nodenext`, `strict`). The
public API is re-exported from `src/index.ts`.

| Module | Responsibility |
|--------|----------------|
| `run.ts` | Runner entry point. Reads env, loads patients/golden/logic model, runs the evaluator bridge, drives the harness, builds the report, writes outputs, and maps the result to an exit code. |
| `case-executor.ts` | `PatientExecutor` — fills a form page-by-page through the harness, reads output fields, and records the actual classification. Also reads the compile manifest, derives pages, and computes observed-outcome coverage. |
| `patient-mapper.ts` | Maps a stored synthetic patient onto the form's page/question structure (`mapPatientToPages`). |
| `evaluator-bridge.ts` | Spawns `python/expected.py`, feeds it the model + cases, parses results, and computes `evaluatorHash`. |
| `evaluator-normalizer.ts` | Converts raw answers to evaluator inputs and evaluator results to expected output fields; age/month helpers. |
| `expected-outcome-source.ts` | The `ExpectedOutcomeSource` abstraction (golden / evaluator). |
| `report-builder.ts` | Pure report assembly: derives each case's status, builds disagreements, computes `passed` and coverage. These are **computed**, never hand-set. |
| `report.ts` | `VerificationReport` types and `VERIFICATION_REPORT_SCHEMA_VERSION`. |
| `hashing.ts` | `sha256`, directory/file-set hashing, and compile-artifact verification against disk. |
| `versions.ts` | Resolves tool versions (cht-conf, Python) and the Python-version gate. |
| `verification-report.schema.json` | JSON Schema for the report; exported as `@cht-nocode/verification/schema`. |

### `python/expected.py` — evaluator bridge

A thin CLI wrapper around R4's evaluator. Given `--model`, `--cases`, and
`--as-of`, it prints one JSON result per case (outcome id, referral, follow-up,
matched rows) on stdout and resolution metadata on stderr. A single bad case
never aborts the batch. Requires **Python ≥ 3.10** and an importable
`jsonschema`; otherwise it exits 2. See "Evaluator as an expected-outcome
source" below for root resolution.

### `vendor/r4/` — vendored evaluator

A copy of R4's evaluator from a zip, **not pinned to a commit** — replace with
the pinned R4 commit when available, and do not edit the files. `MANIFEST.json`
records a sha256 per file plus the `evaluatorHash`. Used only as the last-resort
evaluator root.

### `test/` and `scripts/`

`scripts/run-tests.mjs` selects between the quick unit suite (default) and the
slow suite (`--slow`, tests that boot the real runner and Chromium). Fixtures
live under `test/fixtures/` (a vendored `child-cough-project`, `patients.json`,
`golden-cases.json`, `child-cough.logic.json`) and `test/seeded-defects/`.

> **Fixture provenance / safety.** `test/fixtures/child-cough-project` is test
> data copied from R5's earlier compile output. Its thresholds and logic have
> **not** been clinically reviewed. It exists only to exercise this package's
> code paths and is **not release evidence**.

### `docs/sample-report.json`

A reference `VerificationReport` showing the output shape.

---

## Build

```sh
npm run build        # tsc -p tsconfig.json  +  bundle:assets  ->  dist/
```

`bundle:assets` copies `test/fixtures/patients.json` to `dist/data/patients.json`
(the bundled default patient set) and the schema to `dist/`. The container entry
point is `node /verifier/dist/run.js`; `dist/run.js` is the entry.

## Run

Configured entirely through environment variables.

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `CHT_CONFIG_DIR` | yes | — | Built CHT project (forms, manifest, `app_settings.json`) |
| `OUT_DIR` | no | `/out` | Where `report.json` and `verification.log` are written |
| `TZ` | yes | — | IANA zone, e.g. `Africa/Nairobi`. Unset or invalid → exit 2 |
| `PATIENTS_FILE` | no | bundled `dist/data/patients.json` | Patient set; `patientSetHash` is sha256 of the chosen file's bytes |
| `GOLDEN_CASES_FILE` | no | `/in/golden-cases.json` if present, else none | Golden cases; adds a golden source per case. Hashed into `goldenCasesHash` |
| `LOGIC_MODEL_FILE` | no | `/in/logic.json`, else `${CHT_CONFIG_DIR}/logic.json` if present | Logic model for the evaluator source |
| `EVALUATOR_ROOT` | no | repo `packages/`, else `vendor/r4` | Root added to the Python `sys.path` for R4's evaluator |
| `PYTHON_BIN` | no | `python3` | Python interpreter used for the evaluator bridge |
| `HARNESS_MODULE_PATH` | no | — | First place to look for `cht-conf-test-harness` |
| `LOGIC_MODEL_HASH` | no | — | R2's **envelope** hash. Checked against manifest `snapshotHash` (`sha256:` stripped) and echoed into `references.logicModelHash` (check name `logicModelHash`) |
| `EXPECTED_SNAPSHOT_HASH` | no | — | Alias of `LOGIC_MODEL_HASH` for the same `snapshotHash` check |
| `INPUT_HASH` | no | — | The **bare model** hash. Checked against manifest `inputHash` (`sha256:` stripped); mismatch → exit 1 (check `inputHash`). When set it replaces the informational `logicModelInputHash` check |
| `GOLDEN_CASES_HASH` | no | — | Expected hash of the golden file actually loaded (`sha256:` stripped); mismatch → exit 1 (check `goldenCasesHashExpected`). Provided with no golden file loaded → fail |
| `COMPILE_ARTIFACT_HASH` | no | — | Compared to the compiled artifact hash (`sha256:` stripped); mismatch → exit 1. Echoed as `references.expectedCompileArtifactHash` |
| `CHT_CONF_VERSION` | no | — | cht-conf version fallback when `cht --version` is unavailable |
| `SNAPSHOT_ID` | no | — | Echoed into `references`, never verified |
| `REVISION` | no | — | Echoed into `references` (string), never verified |
| `CLINICAL_APPROVAL_ID` | no | — | Echoed into `references`; the only approval reference |
| `COMPILATION_JOB_ID` | no | — | Echoed into `references`, never verified |
| `PACKAGE_HASH` | no | — | Echoed into `references` and top-level `packageHash`, never verified |

```sh
CHT_CONFIG_DIR=/path/to/project TZ=Africa/Nairobi PATIENTS_FILE=/path/patients.json \
  npm start
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Passed |
| `1` | Verification failed, with a valid `report.json` written |
| `2` | Runner error, no `report.json` written |

### Notes

- **`toolVersionsKnown`** is `ok:false` unless the cht-conf version resolves,
  which needs `cht` on `PATH` or `CHT_CONF_VERSION` set.
- **`logicModelHash`** compares `LOGIC_MODEL_HASH` (or its alias
  `EXPECTED_SNAPSHOT_HASH`) to the manifest `snapshotHash`, stripping an
  optional `sha256:` prefix. When neither is provided the check is
  informational (`ok:true`, "not provided; R7 cross-checks snapshotHash"), so a
  standalone run no longer fails solely for lacking the hash. A provided value
  that mismatches still fails.
- The report carries top-level `version` (= `schemaVersion`) and `packageHash`
  (= `references.packageHash`) for R7's verify stage, alongside the full
  structured fields.
- The runner uses a fixed clock of **`2026-02-15`** for age and follow-up date
  calculations, so a run is reproducible given the same inputs and `TZ`.

## Test

```sh
npm test             # quick suite: pure unit tests
npm run test:slow    # slow suite: boots the real runner + Chromium
```

Both scripts build `src/` and `test/` first, then run `node:test` over
`dist-test/` via `scripts/run-tests.mjs`. Quick tests are everything except
`*.slow.test.js`; the slow suite is `*.slow.test.js` only (exit-codes,
verify-stage, golden, evaluator, seeded-defects).

### Node versions

Tests and the runner are verified on **Node 20 and Node 22** (both are what the
CHT toolchain targets).

### What the slow tests need

- **Fixture project** — vendored at `test/fixtures/child-cough-project/`
  (`child_cough.xml`, `.properties.json`, `.xlsx`, `compile-manifest.json`,
  `compile-rows.json`, `app_settings.json`, `harness.defaults.json`) and
  `test/fixtures/patients.json`. No external path is required.
- **Python** — a `python3` **≥ 3.10** must be on `PATH` (cht-conf's form tooling
  and the runner's version gate need it). If it is missing or too old, the
  exit-code tests **fail with a clear message** (they do not skip silently). On
  a host whose system `python3` is older, put a newer one first on `PATH`, e.g.
  with `uv`:

  ```sh
  P=$(uv python find 3.12); mkdir -p /tmp/pyshim; ln -sf "$P" /tmp/pyshim/python3
  PATH=/tmp/pyshim:$PATH npm run test:slow
  ```

- **Chromium** — the harness downloads its own Chromium on first use (can take a
  minute); the host must have the shared libraries headless Chromium needs (see
  the build image).

## Evaluator as an expected-outcome source

When a logic model is available the runner calls R4's Python evaluator (via
`python/expected.py`) to produce an expected outcome per patient, in addition to
any golden cases. Evaluator and golden are compared independently and against
each other (disagreement makes `passed` false).

- **Logic model:** `LOGIC_MODEL_FILE` (default `/in/logic.json`). Absent → the
  evaluator is skipped (`evaluator skipped: no logic model`); synthetic patients
  with no other source stay `error`. Present but Python/jsonschema missing or no
  evaluator root resolvable → the run exits 2.
- **Evaluator root resolution (one root on `sys.path`), in order:**
  1. `EVALUATOR_ROOT` env;
  2. the repo's `packages/` (R4's code after merge), if
     `../../packages/evaluator/evaluate.py` exists;
  3. the vendored copy at `vendor/r4`.

  The report records `evaluatorRoot`, `evaluatorSource`
  (`env` | `repo` | `vendored-zip-unpinned`) and `evaluatorHash`.
- **Vendoring status:** `vendor/r4` is unpinned (see `vendor/r4/README.md`).
  Replace with the pinned R4 commit when pushed.
- **Python:** requires **python3 ≥ 3.10** on `PATH` and `jsonschema` importable.

## Harness module resolution

`cht-conf-test-harness` is resolved in this order (the baked image copy must win
over a stray `NODE_PATH` entry): `HARNESS_MODULE_PATH`, then
`/build-image/node_modules` if it contains the harness, then `NODE_PATH`, then
normal Node resolution. The chosen path is logged. If none resolves → exit 2.

## Report field semantics (for R2)

`passed`, each case `status`, and `coverageComplete` are **computed** by the
builder and must never be set by hand.

| Field | Origin | What R2 should bind it to |
|-------|--------|---------------------------|
| `passed` | COMPUTED | the gate result (false on any fail/disagree/error, empty cases, incomplete coverage, or a failed integrity check) |
| `coverage` / `coverageComplete` | COMPUTED | observed-outcome branch coverage over the required set |
| `compileArtifactHash` | COMPUTED | the manifest artifact hash the verifier confirmed against disk |
| `testedDirHash` | COMPUTED | sha256 over the whole tested directory (incl. `.xml`) |
| `patientSetHash` | COMPUTED | sha256 of the patient-set file bytes |
| `goldenCasesHash` | COMPUTED | sha256 of the golden file bytes, or null |
| `evaluator` block | COMPUTED | evaluator provenance (source, root, `evaluatorHash`, python/jsonschema versions, `logicModelSource`, `asOf`) |
| `asOf` | COMPUTED | the fixed clock used for age/follow-up |
| `packageHash` | ECHOED (`PACKAGE_HASH`) | cross-check against the job's package hash |
| `references.expectedCompileArtifactHash` | ECHOED (`COMPILE_ARTIFACT_HASH`) | expected value; the `compileArtifactHashExpected` check compares |
| `references.logicModelHash` | ECHOED (env) | cross-check vs snapshotHash (`logicModelHash` check) |
| `references.snapshotId` | ECHOED (env) | the approved logic snapshot id |
| `references.revision` | ECHOED (env, string) | source revision |
| `references.clinicalApprovalId` | ECHOED (env) | the ONLY approval reference |
| `references.compilationJobId` | ECHOED (env) | the compile job id |

**Follow-up date comparison.** The follow-up date field
(`manifest.outputFields.followUpDate`) is compared by **calendar day** — the
form emits local midnight with an offset (e.g. `2026-02-20T00:00:00.000+03:00`)
while sources give a calendar day (`2026-02-20`). Only the leading `YYYY-MM-DD`
is compared, with no `Date` parsing or timezone conversion (which would shift
`+offset` midnight into the previous UTC day). Every other field is compared
strictly. When a case matched only via this day-only rule, its `failureDetail`
carries a note.

## Integration assumptions (unconfirmed with R2/R7)

These are assumptions this package makes about the surrounding pipeline; confirm
with R2 (orchestrator) and R7 (container/verify stage):

- `PACKAGE_HASH` is supplied as an env var and echoed (never verified here).
- The logic model is mounted at `/in/logic.json` (overridable via
  `LOGIC_MODEL_FILE`).
- Python 3.10+ and `jsonschema` are present in the image.
- R4's evaluator folders sit beside `dist/` (repo `packages/`) or are pointed to
  by `EVALUATOR_ROOT`; otherwise the vendored copy is used.
- `dist/` is built by `npm ci && npm run build` (which also bundles
  `dist/data/patients.json`).
- `TZ=Africa/Nairobi` is set; the as-of date is the fixed clock `2026-02-15`.
- Exit codes: `0` pass, `1` fail-with-report, `2` runner error / no report.
- The R2 gate blocks on `passed:false`, exit `2`, or a missing report.
