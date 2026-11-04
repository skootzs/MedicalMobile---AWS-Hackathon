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
| `TZ` | yes | — | IANA zone, e.g. `Africa/Nairobi`. Unset or invalid -> exit 2 |
| `OUT_DIR` | no | `/out` | Where `report.json` and `verification.log` are written |
| `PATIENTS_FILE` | no | — | `patients.json` (synth output); `patientSetHash` is sha256 of its bytes |
| `CHT_CONF_VERSION` | no | — | Fallback cht-conf version if `cht --version` is unavailable |
| `EXPECTED_SNAPSHOT_HASH` | no | — | If set, must equal the manifest `snapshotHash` |
| `SNAPSHOT_ID`, `LOGIC_MODEL_HASH`, `REVISION`, `CLINICAL_APPROVAL_ID`, `COMPILATION_JOB_ID`, `PACKAGE_HASH` | no | — | Echoed into `references`, never verified |

Exit codes: `0` passed, `1` verification failed with a valid `report.json`,
`2` runner error with no `report.json`.

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
