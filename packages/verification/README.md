# @cht-nocode/verification

Synthetic-patient verification for compiled CHT configuration. Runs the built
form and tasks through `cht-conf-test-harness`, records observed outcomes, and
writes a `VerificationReport` (`report.json`) plus a `verification.log`.

No model/LLM calls anywhere. Expected outcomes come only from golden cases and
a teammate's evaluator (not yet wired); with no expected source every case is
`error` and the report's `passed` is `false`.

## Build

```sh
npm run build        # tsc -p tsconfig.json  ->  dist/ (dist/run.js is the entry)
```

The container entry point is `node /verifier/dist/run.js`.

## Run

Configured entirely through environment variables:

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `CHT_CONFIG_DIR` | yes | — | Built CHT project (forms, manifest, `app_settings.json`) |
| `OUT_DIR` | no | `/out` | Where `report.json` and `verification.log` are written |
| `TZ` | yes | — | IANA zone, e.g. `Africa/Nairobi`. Unset or invalid -> exit 2 |
| `PATIENTS_FILE` | no | bundled `dist/data/patients.json` | Patient set; `patientSetHash` is sha256 of the chosen file's bytes |
| `GOLDEN_CASES_FILE` | no | `/in/golden-cases.json` if present, else none | Golden cases; adds a golden source per case. Hashed into `goldenCasesHash` |
| `LOGIC_MODEL_FILE` | no | `/in/logic.json`, else `${CHT_CONFIG_DIR}/logic.json` if present | Logic model for the evaluator source |
| `EVALUATOR_ROOT` | no | repo `packages/`, else `vendor/r4` | Root added to the Python `sys.path` for R4's evaluator |
| `PYTHON_BIN` | no | `python3` | Python interpreter used for the evaluator bridge |
| `HARNESS_MODULE_PATH` | no | — | First place to look for `cht-conf-test-harness` |
| `LOGIC_MODEL_HASH` | no | — | Compared to manifest `snapshotHash` (`sha256:` stripped); echoed into `references` |
| `EXPECTED_SNAPSHOT_HASH` | no | — | Alias of `LOGIC_MODEL_HASH` for the same `snapshotHash` check |
| `COMPILE_ARTIFACT_HASH` | no | — | Compared to the compiled artifact hash (`sha256:` stripped); mismatch -> exit 1. Echoed as `references.expectedCompileArtifactHash` |
| `CHT_CONF_VERSION` | no | — | cht-conf version fallback when `cht --version` is unavailable |
| `SNAPSHOT_ID` | no | — | Echoed into `references`, never verified |
| `REVISION` | no | — | Echoed into `references` (string), never verified |
| `CLINICAL_APPROVAL_ID` | no | — | Echoed into `references`; the only approval reference |
| `COMPILATION_JOB_ID` | no | — | Echoed into `references`, never verified |
| `PACKAGE_HASH` | no | — | Echoed into `references` and top-level `packageHash`, never verified |

Exit codes: `0` passed, `1` verification failed with a valid `report.json`,
`2` runner error with no `report.json`.

Notes:
- **`toolVersionsKnown`** is `ok:false` unless the cht-conf version resolves,
  which needs `cht` on `PATH` or `CHT_CONF_VERSION` set.
- **`logicModelHash`** check compares `LOGIC_MODEL_HASH` (or its alias
  `EXPECTED_SNAPSHOT_HASH`) to the manifest `snapshotHash`, stripping an
  optional `sha256:` prefix. When neither is provided the check is
  informational (`ok:true`, "not provided; R7 cross-checks snapshotHash"), so a
  standalone run no longer fails solely for lacking the hash. A provided value
  that mismatches still fails. (This relaxes the earlier fail-closed default.)
- The report carries top-level `version` (= `schemaVersion`) and `packageHash`
  (= `references.packageHash`) for R7's verify stage, in addition to the full
  structured fields.

```sh
CHT_CONFIG_DIR=/path/to/project TZ=Africa/Nairobi PATIENTS_FILE=/path/patients.json \
  npm start
```

## Test

```sh
npm test             # builds src + tests, then: node --test dist-test/test/*.test.js
```

### Node versions

Tests and the runner are verified on **Node 20 and Node 22** (both are what the
CHT toolchain targets). TypeScript is fetched on demand via `npx -y -p
typescript@5`, so no global install is needed.

### Exit-code tests: what they need

`test/exit-codes.test.ts` spawns the compiled `dist/run.js` as a child process
to check the real exit-code mapping. It is self-contained except for Python:

> **Fixture provenance / safety.** `test/fixtures/child-cough-project` is test
> data copied from R5's earlier compile output. Its thresholds and logic have
> **not** been clinically reviewed. It exists only to exercise this package's
> code paths and is **not release evidence**. `test/fixtures/patients.json` is a
> snapshot of the synth patient set used by the tests.

- **Fixture project** — vendored at `test/fixtures/child-cough-project/`
  (`child_cough.xml`, `.properties.json`, `.xlsx`, `compile-manifest.json`,
  `compile-rows.json`, `app_settings.json`, `harness.defaults.json`) and
  `test/fixtures/patients.json`. No external path is required.
- **Python** — a `python3` **>= 3.10** must be on `PATH` (cht-conf's form
  tooling and the runner's version gate need it). If it is missing or too old,
  the exit-code tests **fail with a clear message** (they do not skip silently).
  On a host whose system `python3` is older, put a newer one first on `PATH` for
  the test run, e.g. with `uv`:

  ```sh
  P=$(uv python find 3.12); mkdir -p /tmp/pyshim; ln -sf "$P" /tmp/pyshim/python3
  PATH=/tmp/pyshim:$PATH npm test
  ```

- **Chromium** — the harness downloads its own Chromium on first use; the host
  must have the shared libraries headless Chromium needs (see the build image).

The first harness run downloads Chromium and can take a minute.

## Evaluator as an expected-outcome source

When a logic model is available the runner calls R4's Python evaluator (via
`python/expected.py`) to produce an expected outcome per patient, in addition
to any golden cases. The evaluator and golden are compared independently and
against each other (disagreement makes `passed` false).

- **Logic model:** `LOGIC_MODEL_FILE` (default `/in/logic.json`). Absent: the
  evaluator is skipped (`evaluator skipped: no logic model`); synthetic patients
  with no other source stay `error`. Present but Python/jsonschema missing or no
  evaluator root resolvable: the run exits 2.
- **Evaluator root resolution (one root on `sys.path`), in order:**
  1. `EVALUATOR_ROOT` env;
  2. the repo's `packages/` (R4's code after merge), if
     `../../packages/evaluator/evaluate.py` exists;
  3. the vendored copy at `vendor/r4`.
  The report records `evaluatorRoot`, `evaluatorSource`
  (`env` | `repo` | `vendored-zip-unpinned`) and `evaluatorHash`.
- **Vendoring status:** `vendor/r4` is a copy of R4's evaluator from a zip,
  **not pinned to a commit** (see `vendor/r4/README.md`). Replace with the
  pinned R4 commit when pushed.
- **Python:** requires **python3 >= 3.10** on `PATH` and the `jsonschema`
  package importable.

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

## Harness module resolution

`cht-conf-test-harness` is resolved in this order (the baked image copy must
win over a stray NODE_PATH entry): `HARNESS_MODULE_PATH`, then
`/build-image/node_modules` if it contains the harness, then `NODE_PATH`, then
normal Node resolution. The chosen path is logged. If none resolves, exit 2.

## Report field semantics (for R2)

`passed`, each case `status`, and `coverageComplete` are **computed** by the
builder and must never be set by hand. The schema is importable at the package
export path `@cht-nocode/verification/schema`.

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
| `packageHash` | ECHOED (env `PACKAGE_HASH`) | cross-check against the job's package hash |
| `references.expectedCompileArtifactHash` | ECHOED (env `COMPILE_ARTIFACT_HASH`) | the expected value; the `compileArtifactHashExpected` check does the compare |
| `references.logicModelHash` | ECHOED (env) | cross-check vs snapshotHash (done by the `logicModelHash` check) |
| `references.snapshotId` | ECHOED (env) | the approved logic snapshot id |
| `references.revision` | ECHOED (env, string) | source revision |
| `references.clinicalApprovalId` | ECHOED (env) | the ONLY approval reference |
| `references.compilationJobId` | ECHOED (env) | the compile job id |

Package name: `@cht-nocode/verification`. Schema export path:
`@cht-nocode/verification/schema` (resolves to the bundled
`verification-report.schema.json`).
