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
| `PATIENTS_FILE` | no | bundled `dist/data/patients.json` | Patient set; `patientSetHash` is sha256 of the chosen file's bytes. If unset and the bundled file is absent, the run has no patients (fails) |
| `GOLDEN_CASES_FILE` | no | — | Golden cases file; when set, adds a golden expected-outcome source per case. Hashed into `goldenCasesHash` |
| `CHT_CONF_VERSION` | no | — | cht-conf version fallback when `cht --version` is unavailable |
| `EXPECTED_SNAPSHOT_HASH` | no | — | If set, must equal the manifest `snapshotHash` (integrityCheck) |
| `LOGIC_MODEL_HASH` | no | — | If set, must equal manifest `inputHash`; echoed into `references`. See note below |
| `SNAPSHOT_ID` | no | — | Echoed into `references`, never verified |
| `REVISION` | no | — | Echoed into `references`, never verified |
| `CLINICAL_APPROVAL_ID` | no | — | Echoed into `references`; the only approval reference |
| `COMPILATION_JOB_ID` | no | — | Echoed into `references`, never verified |
| `PACKAGE_HASH` | no | — | Echoed into `references` and promoted to top-level `packageHash`, never verified |

Exit codes: `0` passed, `1` verification failed with a valid `report.json`,
`2` runner error with no `report.json`.

Notes:
- **`toolVersionsKnown`** is `ok:false` unless the cht-conf version resolves,
  which needs `cht` on `PATH` or `CHT_CONF_VERSION` set.
- **`logicModelHash`** check is `ok:false` by design when `LOGIC_MODEL_HASH` is
  not provided, so a standalone run without it never reports `passed:true`.
  R7's verify stage supplies it from the job.
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
