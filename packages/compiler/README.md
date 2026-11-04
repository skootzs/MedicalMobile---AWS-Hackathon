# @cht-nocode/compiler (Role 5)

Deterministic compiler from a structured `LogicModel` (JSON) to a CHT app form: an XLSForm `.xlsx` plus its `.properties.json`. No model calls and no clock or randomness, so the same input and options give byte-identical files. Any unsupported construct or invalid input fails the **whole** compilation with a list of coded errors; nothing is written.

> **Status: integration-ready MVP on branch `compiler`. The input contract is provisional** (`src/logic-model.ts`, mirroring `docs/logic-model-v1-proposal.md`) until Role 4 publishes `packages/schema`. The child cough fixture is **technical demonstration logic, not clinician-approved**.

## Requirements

| Tool | Version | Used for |
|---|---|---|
| Node.js | ≥ 22.18 (tested 24.14.1) | Runs the `.ts` sources directly (type stripping); no build step |
| cht-conf | 6.6.1 (pinned in `reference/reference_file.json`) | Conversion and validation gate. Not needed to compile |
| Python | ≥ 3.10 | Used by cht-conf's bundled converter |
| `SHIV_ROOT` env var | writable folder | Only if `$HOME/.shiv` is not writable (e.g. sandboxes, read-only CI home) |

The compiler has **no runtime dependencies**. Dev dependencies are `typescript` and `@types/node`.

## API (Role 2: approval service; Role 7: runner)

```ts
import { compileLogicModel, writeCompiledProject } from '@cht-nocode/compiler'; // src/index.ts

compileLogicModel(input: unknown, options?: CompileOptions): CompileResult
//   options: { snapshotHash?: string;  // approved snapshot hash from Role 2, copied into the manifest
//              watermark?: string;     // e.g. "DEMONSTRATION ONLY"; shown in red on page 1 and the summary
//              icon?: string }         // key in the target project's resources.json; default "icon-healthcare"
//   returns { ok: true, artifact: CompiledArtifact } | { ok: false, errors: CompileError[] }
//   CompileError = { code: CompileErrorCode; path: string /* JSON path, e.g. $.questions[3].type */; message: string }

writeCompiledProject(artifact: CompiledArtifact, outDir: string): string[]
//   writes the files below into an empty or missing outDir; throws if outDir has other files
```

`CompiledArtifact` contains `formId`, `xlsForm` (rows as data), `properties`, `files` (`{ path, sha256, bytes }`) and `manifest`. The function is pure: it never touches the filesystem.

### CLI

```sh
node src/cli.ts <logic-model.json> --out <dir> [--snapshot-hash H] [--watermark TEXT] [--icon KEY]
```

| Exit | Meaning | Output |
|---|---|---|
| 0 | Compiled | stdout JSON: `ok`, `outDir`, `formId`, `artifactHash`, `inputHash`, `files` |
| 1 | Rejected | stderr JSON: `{ ok: false, errors: [...] }`; nothing written |
| 2 | Usage or file error | stderr message |

### Compile and check in one step

```sh
CHT=/path/to/cht SHIV_ROOT=/tmp/shiv \
  scripts/build-and-check.sh <logic-model.json> <out-dir> [compiler options]
```

Compiles, then runs `cht --local --skip-dependency-check --skip-git-check convert-app-forms validate-app-forms -- <formId>` inside `<out-dir>`. A non-zero exit from either step fails the script.

## Generated files

```
<outDir>/forms/app/<pathwayId>.xlsx              XLSForm (survey, choices, settings sheets)
<outDir>/forms/app/<pathwayId>.properties.json   title, icon, context (person forms only)
<outDir>/compile-manifest.json                   hashes, options, output fields, outcomes, open ambiguities
<outDir>/compile-rows.json                       the XLSForm rows as JSON, for review and diffs
<outDir>/forms/app/<pathwayId>.xml               written by cht-conf convert-app-forms, not by the compiler
```

`<outDir>` is a minimal cht-conf project: copy `forms/app/*` into the real CHT project (`templates/cht-base` when it exists). The form version in the settings sheet is `v1_<first 12 characters of inputHash>`.

### Hashes in the manifest

- `inputHash`: sha256 of the canonical JSON of the input (keys sorted, so key order does not matter).
- `artifactHash`: sha256 of the sorted lines `path<TAB>sha256` for the two generated form files. Use it to tie an approved snapshot to the files that were deployed.
- `snapshotHash`: whatever Role 2 passes in. The compiler does not compute it; how the snapshot is canonicalised and hashed is still to be agreed with Role 2.

## Fields to test against (Role 6)

All of these are top-level calculates in the submitted report (`/data/...`). Their names are also listed in `manifest.outputFields`:

| Field | Values |
|---|---|
| `<decisionTables[0].id>` (`classification` in the fixture) | an outcome id: the first matching row, otherwise the table's `otherwise`; or the applicability outcomes |
| `in_scope` | `yes`, `no`, `unknown` (only when `applicability` is present) |
| `referral_urgent` | `yes` or `no` |
| `follow_up_days` | a number, or empty |
| `t_follow_up_date` | the follow-up date, or empty |
| each `derived[].id` | `yes`, `no`, or empty when not yet known |

Rules for unanswered values: a condition on an unanswered value is unknown, not false. A decision row matches only when its condition is definitely true. So a partly filled form classifies as the `otherwise` outcome (`incomplete` in the fixture), never as a milder outcome. See `docs/logic-model-v1-proposal.md`.

Suggested harness cases for the fixture: each of the four rows, both age bands either side of each threshold (49/50 breaths at 2–11 months, 39/40 at 12–59 months), age 1 and 60 months (out of scope), and no date of birth (age unknown).

## Tests

```sh
npm install                 # dev dependencies only
npm run typecheck           # tsc, no emit
npm test                    # 72 unit tests: XPath generation, validation, xlsx writer
CHT_BIN=/path/to/cht SHIV_ROOT=/tmp/shiv npm run test:integration
```

The integration test compiles `test/fixtures/child-cough.logic.json`, runs real cht-conf conversion and validation, checks the XForm fields, checks that the questions match the handwritten reference (`reference/child-cough/`), and checks that a second build gives an identical XForm. If cht-conf cannot be run, it reports **skipped**, not passed. Set `REQUIRE_CHT=1` in CI so that a missing cht-conf fails.

## What v1 supports

- Questions: `boolean` (yes/no), `integer`, `decimal` (with `min` / `max`), `select_one`. All required when shown.
- Conditions: `and`, `or`, `not`, `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `answered`, always comparing an id with a literal.
- One context value: `contact.age_in_months`, from the contact's date of birth.
- Applicability, with named outcomes for "not applicable" and "unknown".
- Derived yes/no values, one decision table, outcomes with urgent referral and follow-up days, an optional watermark, pages.

## Rejected with an error (by design)

Any unknown field; another schema version or language; `select_multiple`, text, date or any other question type; comparing two fields; expression strings; numbers in exponent form; more or fewer than one decision table; outcomes that cannot be reached or are not defined; references to later questions; reserved or invalid ids; `${`, `<`, `>` or control characters in display text; and any **open ambiguity marked `blocking: true`**. Error codes are listed in `src/errors.ts`.

## Known limitations

1. **Provisional schema.** It will change to Role 4's `packages/schema` once published.
2. **Form behaviour is not yet tested in CHT.** cht-conf conversion and validation pass, but they do not run the XPath. Outcomes for given answers still need `cht-conf-test-harness` (Role 6).
3. `hitPolicy: "unique"` is compiled as "first match in row order". It does not check that rows cannot overlap; that proof is Role 4's checker.
4. English only; one decision table; no tasks (`tasks.js`), targets or contact forms.
5. No check against the deployed baseline yet: renamed field ids (`ID_CHANGED_FROM_BASELINE`) are not detected.
6. The compiler does not merge into `templates/cht-base`, which is still empty. The icon key must exist in that project's `resources.json`.
7. Tested on macOS arm64 with a local cht-conf install, not in the pinned `medicmobile/cht-app-ide:v6.6.1` image (amd64 only; Docker was not available).
8. cht-conf warns "Group has no label" for the standard `inputs/contact` and `inputs/contact/parent` groups. This is the normal CHT pattern; the warnings are expected.
