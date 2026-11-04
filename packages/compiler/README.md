# @cht-nocode/compiler (Role 5)

Deterministic compiler from a structured `LogicModel` (JSON) to CHT configuration: an XLSForm `.xlsx` plus its `.properties.json`, and a follow-up task in `tasks.js` when an outcome has a follow-up. No model calls and no clock or randomness, so the same input and options give byte-identical files. Any unsupported construct or invalid input fails the **whole** compilation with a list of coded errors; nothing is written.

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
//              icon?: string;          // key in the target project's resources.json; default "icon-healthcare"
//              taskWindow?: { start: number; end: number } } // days before/after the follow-up date; default 0/2
//   returns { ok: true, artifact: CompiledArtifact } | { ok: false, errors: CompileError[] }
//   CompileError = { code: CompileErrorCode; path: string /* JSON path, e.g. $.questions[3].type */; message: string }

writeCompiledProject(artifact: CompiledArtifact, outDir: string, options?: { template?: string; diff?: CompileDiff }): string[]
//   writes the files below into an empty or missing outDir; throws if outDir has other files.
//   With `template`, copies that CHT project into outDir first (the template itself is never changed).

diffAgainstBaseline(artifact, baselineManifest, baselineRows): CompileDiff
//   compares with the compile-manifest.json and compile-rows.json of a previous build
```

`CompiledArtifact` contains `formId`, `xlsForm` (rows as data), `properties`, `files` (`{ path, sha256, bytes }`) and `manifest`. The function is pure: it never touches the filesystem.

### CLI

```sh
node src/cli.ts <logic-model.json> --out <dir> [--template DIR] [--baseline DIR]
  [--snapshot-hash H] [--watermark TEXT] [--icon KEY] [--task-window START,END]
```

| Exit | Meaning | Output |
|---|---|---|
| 0 | Compiled | stdout JSON: `ok`, `outDir`, `formId`, `artifactHash`, `inputHash`, `template`, `baseline`, `files` |
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
<outDir>/tasks.js                                the follow-up task (only when an outcome has a follow-up)
<outDir>/translations/messages-en.properties     the task title; appended to the template's file
<outDir>/compile-manifest.json                   hashes, options, output fields, outcomes, task, open ambiguities
<outDir>/compile-rows.json                       the XLSForm rows as JSON, for review and diffs
<outDir>/compile-diff.json                       changes against --baseline (only with --baseline)
<outDir>/forms/app/<pathwayId>.xml               written by cht-conf convert-app-forms, not by the compiler
<outDir>/app_settings.json                       written by cht-conf compile-app-settings; the harness reads this
```

Without `--template`, `<outDir>` is a minimal cht-conf project holding only the files above. With `--template DIR` (e.g. `templates/cht-base`), every file in `DIR` is copied into `<outDir>` first, then the generated files are added. The template is read only and never changed. `.gitkeep` and `.DS_Store` are not copied. Generated translation keys are appended to the template's `translations/messages-en.properties`; a key the template already defines is an error. The compile fails with exit 2, writing nothing, if the template contains a symlink or any other file the compiler or cht-conf would write (`forms/app/<pathwayId>.{xlsx,properties.json,xml}`, `tasks.js`, `compile-*.json`). The form version in the settings sheet is `v1_<first 12 characters of inputHash>`.

`templates/cht-base` is the minimal project this has been tested with: `.eslintrc` and `package.json` (both required by `compile-app-settings`), empty `targets.js` and contact summary, `app_settings/base_settings.json`, `resources.json` with `icon-healthcare`, and `harness.defaults.json` with a synthetic 24-month-old child. It must not contain its own `tasks.js`.

### Follow-up task

When any outcome has `followUp.afterDays`, the compiler writes one task, `<pathwayId>_follow_up`:

- raised by every report of the form whose `t_follow_up_date` is set, so only outcomes with a follow-up raise it;
- due on `t_follow_up_date`, shown from `start` days before until `end` days after (default 0 and 2, set with `--task-window`; recorded in `manifest.tasks` with `windowSource`);
- its action opens the same form again for a reassessment;
- resolved by a later report of the same form for the same contact inside the window.

The window is a compiler default, not guideline content: confirm it with the clinician and pass it explicitly.

### Baseline diff

`--baseline DIR` points at the output folder of the last deployed build (its `compile-manifest.json` and `compile-rows.json`). The compiler writes `compile-diff.json` with added, removed and changed survey rows (keyed by group path) and choices, changed settings except `version`, added, removed and changed outcomes, any change to the task, and `warnings` for things a deploy approver must check: removed fields, a remove-and-add that may be a rename, changed field types, removed outcomes, a changed form id. The manifest's `baseline` gives the baseline's hashes, `identical` and the warning count.

### Build container layout (Role 7)

Compile stage, `node:22-slim`, offline, read-only root:

```sh
node src/cli.ts /in/logic.json --out /out --template /template --snapshot-hash "$SNAPSHOT_HASH" --watermark "DEMONSTRATION ONLY"
```

`/out` must be empty. The compile stage does not run cht-conf, so it needs no Python and no `SHIV_ROOT`. Build stage, `medicmobile/cht-app-ide:v6.6.1`: copy `/in` to `/work/p`, then run `cht --local --skip-dependency-check --skip-git-check compile-app-settings convert-app-forms validate-app-forms` in `/work/p` with `SHIV_ROOT=/work/shiv` and `HOME=/tmp`, then the harness.

### Hashes in the manifest

- `inputHash`: sha256 of the canonical JSON of the input (keys sorted, so key order does not matter).
- `artifactHash`: sha256 of the sorted lines `path<TAB>sha256` for every generated file in `manifest.files`: the form `.xlsx` and `.properties.json`, and when there is a follow-up, `tasks.js` and the generated translation lines (before they are appended to the template's file). Use it to tie an approved snapshot to the files that were deployed.
- `template`: `{ hash, files }`, with the hash computed the same way over every copied template file; `null` without `--template`.
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

Those cases are written in `fixtures/child-cough/golden-cases.json` (22 cases): every outcome, ages 1, 2, 11, 12, 59 and 60 months plus a missing date of birth, 49/50 breaths under 12 months, 39/40 breaths from 12 months up, each general danger sign, stridor, chest indrawing, and two partly answered forms. `expected` holds the strings the submitted report stores (`yes`, `no`, `''`, and follow-up days as `'3'` or `'5'`). `t_follow_up_date` is left out because it depends on the day the form is opened. The same logic model is at `fixtures/child-cough/logic.json`. Every case is marked `not-clinician-approved`. `npm test` checks them against the fixture rules. Role 6 compares `expected` with the harness output; Role 4's evaluator is a separate source.

## Tests

```sh
npm install                 # dev dependencies only
npm run typecheck           # tsc, no emit
npm test                    # unit tests: XPath, validation, xlsx writer, template copy, tasks, diff, golden cases
CHT_BIN=/path/to/cht SHIV_ROOT=/tmp/shiv npm run test:integration
```

`test/harness/child-cough.spec.cjs` runs the compiled form and its task through cht-conf-test-harness 5.0.4: four classifications, the task appearing on day 3 and not before, a reassessment resolving it, and the task closing after the window. Compile with `--template templates/cht-base`, run `cht compile-app-settings convert-app-forms` in the output folder, then from a folder where `cht-conf-test-harness`, `mocha` and `chai@4` are installed:

```sh
CHT_PROJECT=/path/to/output TZ=Africa/Nairobi npx mocha child-cough.spec.cjs --timeout 120000
```

Its expected values are written by hand for the fixture. The broader set, including the boundaries this spec does not open in a browser, is `fixtures/child-cough/golden-cases.json`. Pipeline verification compares the harness output with that file and, separately, with Role 4's evaluator.

The integration test compiles `test/fixtures/child-cough.logic.json`, runs real cht-conf conversion and validation, checks the XForm fields, checks that the questions match the handwritten reference (`reference/child-cough/`), and checks that a second build gives an identical XForm. If cht-conf cannot be run, it reports **skipped**, not passed. Set `REQUIRE_CHT=1` in CI so that a missing cht-conf fails.

## What v1 supports

- Questions: `boolean` (yes/no), `integer`, `decimal` (with `min` / `max`), `select_one`. All required when shown.
- Conditions: `and`, `or`, `not`, `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `answered`, always comparing an id with a literal.
- One context value: `contact.age_in_months`, from the contact's date of birth.
- Applicability, with named outcomes for "not applicable" and "unknown".
- Derived yes/no values, one decision table, outcomes with urgent referral and follow-up days, a follow-up task in `tasks.js`, an optional watermark, pages.

## Rejected with an error (by design)

Any unknown field; another schema version or language; `select_multiple`, text, date or any other question type; comparing two fields; expression strings; numbers in exponent form; more or fewer than one decision table; outcomes that cannot be reached or are not defined; references to later questions; reserved or invalid ids; `${`, `<`, `>` or control characters in display text; and any **open ambiguity marked `blocking: true`**. Error codes are listed in `src/errors.ts`.

## Known limitations

1. **Provisional schema.** It will change to Role 4's `packages/schema` once published.
2. **Form behaviour is tested in the harness for the fixture only** (`test/harness/`, 6 cases), not for every branch. Full branch coverage with expected outcomes from the approved logic is Role 6's.
3. `hitPolicy: "unique"` is compiled as "first match in row order". It does not check that rows cannot overlap; that proof is Role 4's checker.
4. English only; one decision table; one follow-up task per pathway; no targets or contact forms.
5. The baseline diff warns about removed and possibly renamed fields; it does not block them.
6. `templates/cht-base` is minimal: enough for compile, convert, validate and the harness, not a full deployable app. Uploading to a CHT instance needs real `base_settings.json` (or seeding from cht-core `config/default` without its `tasks.js`).
7. Tested on macOS arm64 with local cht-conf 6.6.1 and cht-conf-test-harness 5.0.4, not in the pinned `medicmobile/cht-app-ide:v6.6.1` image (amd64 only; Docker was not available).
8. cht-conf warns "Group has no label" for the standard `inputs/contact` and `inputs/contact/parent` groups. This is the normal CHT pattern; the warnings are expected.
