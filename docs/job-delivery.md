# Job delivery contract

R7 owns job execution (running jobs and reporting results). R2 (Hailey,
Sushma) owns workflow decisions: whether a job is authorized, creating it,
and advancing the request afterward. R7 never makes an approval decision; it
only re-checks one as a second guard and fails closed.

> Job payload/result **types**, JSON Schemas and Ajv validators live in
> `packages/schema/src/handoffs.ts` (confirmed with R4/skootzs). Every
> service validates what it receives against these schemas and fails closed.

## DynamoDB key layout

Single table, on-demand, encrypted at rest, stream enabled
(`NEW_AND_OLD_IMAGES`). See `infra/terraform/dynamodb.tf`.

```
REQ#<requestId>   META | REV#000003 | APPROVAL#<id> | AUDIT#<ts>#<eventId>
JOB#<jobId>       META | RECEIPT#<msgId> | OUTBOX
SNAP#<hash>       META   (pointer to S3 URI + hash)
```

- **GSI1** (`gsi1pk`/`gsi1sk`): jobs per request — `REQ#<requestId>` / `JOB#<createdAt>`
- **GSI2** (`gsi2pk`/`gsi2sk`): reviewer inboxes — `INBOX#<role>` / `<createdAt>`

## Outbox + events contract (section 8, Tiers 2/3)

R2 writes job intent + an audit event + an `OUTBOX` item in **one**
transaction. Delivery is derived from that committed write, so it can never
disagree with the table:

- **Outbox Pipe** (Tier 2): DynamoDB Stream → EventBridge Pipe, filtered to
  `INSERT` where `sk = OUTBOX` and `jobType` is `COMPILE_LOGIC` or `VERIFY_BUILD` → the
  `jobs` SQS queue. The message body is the whole stream record, and the runner reads
  `dynamodb.NewImage.payload` from it and unmarshalls it.
- **Events Pipe** (Tier 3): DynamoDB Stream → EventBridge Pipe, filtered to
  `MODIFY` on `JOB#` `META` items where `status` changed → the `job-events`
  queue, sending `{ requestId, jobId, status, attempt }`. `attempt` is a numeric string,
  because Pipes renders stream values as strings and can't convert them without an enrichment step.

**Fallbacks if Pipes don't work out** (ask R7 before switching): a poller in
the orchestrator for the outbox (runner idempotency makes duplicate sends
safe), and R2 polling job status instead of consuming events.

## Lease, retry and failure behavior

Implemented in `runner/src/worker.ts` and `runner/src/store.ts`.

1. **Receive** from `jobs` (long polling) and validate against
   `packages/schema/src/handoffs.ts`. An invalid payload fails the job
   `INVALID_PAYLOAD`, but only if the job is still `PENDING`, so a garbled message
   can't kill a running job. The message is deleted only once that failure is recorded.
   Otherwise, or if there's no usable `jobId`, it stays on the queue and reaches the DLQ.
2. **Take the job** in one `TransactWriteItems`: put a receipt, update
   `JOB#<jobId>/META` to `RUNNING` with `leaseOwner`/`leaseUntil`/`attempt + 1`
   (condition: `PENDING`, or `RUNNING` with an expired lease), put an audit event.
   - The receipt key is `RECEIPT#<msgId>#<receiveCount>`. SQS redelivers a retried or
     crashed job under the same `MessageId`, so a key on `msgId` alone would block the
     retry. Exclusivity comes from the META condition.
3. **If the take fails:**

   | Job state | Action |
   |---|---|
   | `SUCCEEDED` / `FAILED` | Delete the message |
   | `RUNNING`, lease live | Keep the message and set visibility to just past the lease. It is the only route to takeover if the owner crashes |
   | No META item | Leave it for the DLQ and log an error |
   | Any other status | Throw and leave the message. It is never acked away |

4. **Heartbeat** every `LEASE_SECONDS / 3`: extend `leaseUntil` (conditional on
   `leaseOwner` + `attempt` + `RUNNING`) and the SQS visibility. If the lease is lost,
   the running container is killed and nothing is recorded.
5. **Second guard** (`mode = approved`): `REQ#<requestId>/APPROVAL#<clinicalApprovalId>`
   must exist with `decision = approved`, a matching `logicModelHash` (compared on the
   hex part), and neither `superseded = true` nor `status = SUPERSEDED`. Otherwise
   `APPROVAL_INVALID`.
6. **Failure handling:**

   | Failure | errorCode | Behavior |
   |---|---|---|
   | Compiler exit 1 with `{ ok: false, errors }` on stderr | `MODEL_REJECTED` | Terminal, stores `compileErrors` |
   | Compiler exit 1 with anything else on stderr, or exit 2 | `COMPILE_INFRA_ERROR` | Retryable |
   | `cht` exits non-zero and `convert.log` exists | `CONVERT_FAILED` | Terminal |
   | Convert container never ran (exit >= 125 or no `convert.log`) | `COMPILE_INFRA_ERROR` | Retryable |
   | Stage timeout | `TIMEOUT` | Retryable |
   | Snapshot, package or baseline bytes don't match | `HASH_MISMATCH` | Terminal |
   | Manifest `inputHash` or `snapshotHash` doesn't match | `INPUT_HASH_MISMATCH` | Terminal |
   | Verifier exit 0/1 with a valid report that fails a cross-check | `VERIFY_ERROR` | Terminal |
   | Verifier exit 2, or exit 0/1 with no valid report | `VERIFY_ERROR` | Retryable |
   | A URI outside the artifact bucket | `INVALID_PAYLOAD` | Terminal |

   Retryable means one transaction resets the job to `PENDING`, clears the lease and
   adds an `attempt_failed_retryable` audit event, then visibility is set to 30 s. On
   the last permitted delivery (`ApproximateReceiveCount >= MAX_RECEIVE_COUNT`) the job
   ends `FAILED` with `retryable = true` instead, so it can't sit in `PENDING` after
   the message moves to the DLQ. A worker crash on the last delivery still needs the
   section 10 reconciler.
7. **Commit the result** in one `TransactWriteItems`: update META with the `JobResult`
   fields, conditional on `leaseOwner` + `attempt` + `RUNNING`, plus an audit event.
   Then delete the message.

### Packaging

`project.tgz` is written in-process (`runner/src/package.ts`): sorted entries, mtime
0, uid/gid 0, and a pinned gzip OS byte, so `packageHash` matches on any host.
`shiv/` and `convert.log` are left out. `manifest.json` is stored next to the package
rather than inside it, and lists `files` and `logs` separately.

## Result fields

`JobResult` (full shape in `packages/schema/src/handoffs.ts`) carries, at
minimum: `jobId`, `jobType`, `attempt`, `status` (`SUCCEEDED`/`FAILED`), the
hash chain for that build
(`logicModelHash`/`snapshotHash`/`inputHash`/`compileArtifactHash`/
`templateHash`/`manifestHash`/`packageHash`), `toolVersions` (image digests,
compiler/verifier commits, model ID), `startedAt`/`finishedAt`,
`errorCode`/`errorMessage` (both `null` on success), and `logUri`. The runner also writes
`runnerActorId` to META: `<WORKER_ID>-compile` or `<WORKER_ID>-verify`. A `COMPILE_LOGIC`
result carries `packageVersionId`/`manifestVersionId`, the compile report
(`compileReportUri`/`compileReportHash`/`compileReportVersionId`, which is
`compile-manifest.json`), and `compilerExitCode`/`chtConfStatus`/`failureKind`. A
`VERIFY_BUILD` result additionally carries `reportUri`/`reportVersionId`/`reportHash`/
`verificationPassed`/`coverageComplete`/`testedDirHash`/`reportVersion`. When
the job had a `baselineUri`, it also carries `compileDiffUri` (the uploaded
`compile-diff.json`).

### Baseline diff (compiler@7f488e6)

`JobPayload` gained two optional fields:

- `baselineUri`: S3 prefix of the **last deployed** build's `/out` (i.e. the
  folder containing that build's `compile-manifest.json` and
  `compile-rows.json`). R2 decides which build counts as "last deployed";
  the runner just uses whatever URI it's given, with no opinion of its own.
- `taskWindow`: `"<start>,<end>"` days before/after the follow-up date;
  passed to the compiler verbatim as `--task-window <value>`.

When `baselineUri` is set, the runner downloads it, **verifies the stored
hashes** before trusting it, mounts it read-only at `/baseline`, and passes
`--baseline /baseline` to the compiler. The compiler then writes
`compile-diff.json` (added/removed/changed survey rows and choices, changed
settings except `version`, added/removed/changed outcomes, any task change,
and `warnings` a deploy approver must check — e.g. a possible field rename).
The runner uploads it alongside the other build artifacts and records
`compileDiffUri` on the `JobResult`. No hash fields change shape for this —
it's a new, independent artifact.

### Hash identities

Keep each of these separate — they are not interchangeable, even though
several of them flow through the same job.

| Name | Owner | Exact bytes it covers |
|---|---|---|
| `logicModelHash` | R2 | sha256 over the RFC 8785 (JCS) canonical snapshot envelope, excluding the top-level `snapshotHash` field. R2 stores exactly those canonical bytes (envelope metadata + `content`, without `snapshotHash`) at `snapshots/<logicModelHash>.json`, so `sha256(object bytes) == logicModelHash`. The bare LogicModel is the envelope's `content` field. TODO: confirm with R2 whether the value carries a `sha256:` prefix; compare hex parts either way. |
| `snapshotHash` | R2 → R5 | Not a new hash — it's `logicModelHash`, passed to the compiler with `--snapshot-hash` and copied into `compile-manifest.json`. Must match `^[A-Za-z0-9:_-]{8,128}$`. |
| `inputHash` | R5 | The bare LogicModel only: sha256 (hex) of canonical JSON with object keys sorted at every level, no whitespace, array order kept, values as `JSON.stringify` writes them. The runner computes the same hash over the bytes it writes to `/in/logic.json` and compares. |
| `checkReportHash` | R4 / R2 | sha256 of the canonical checker report JSON. Recorded by the runner; the compiler doesn't read it. |
| `compileArtifactHash` | R5 | Manifest `artifactHash`: sha256 of lines `path\tsha256hex\n`, sorted by path, over every file in `manifest.files` — the form `.xlsx` + `.properties.json`, and (compiler@7f488e6) `tasks.js` + the generated translation lines too when the pathway has a follow-up. Still does **not** cover `.xml`. No runner change needed; keep recording it as-is. |
| `templateHash` | R5 | Manifest `template.hash`: same method over every file copied from `/template` (excluding `.gitkeep`, `.DS_Store`). |
| `manifestHash` | R7 | sha256 of the canonical `manifest.json`, which lists path + sha256 of every file after convert (including `.xml`). |
| `testedDirHash` | R6 | From VerificationReport v2.0.0: hash of the directory the harness tested (R6's definition). Recorded separately; the runner doesn't recompute it. |
| `packageHash` | R7 | sha256 of the `project.tgz` bytes. Integrity check for the download. The tarball is built deterministic anyway, but the **build identity** is `inputHash` + `compileArtifactHash` + `templateHash` (+ `manifestHash` once converted). |

Release approval binds to `packageHash` (exact bytes downloaded) +
`manifestHash`. R6's report references `packageHash`. R2 stores per build:
`snapshotHash`, `inputHash`, `compileArtifactHash`, `templateHash`,
`manifestHash`, `packageHash`.

### Verify stage (R6's verifier @ `e9f70f6`, report 2.3.0)

The verify container runs `node /verifier/dist/run.js` with:

| Env var | Value |
|---|---|
| `CHT_CONFIG_DIR` | `/project` (read-only) |
| `OUT_DIR` | `/out` |
| `TZ` | `Africa/Nairobi` |
| `PACKAGE_HASH` | the payload's `packageHash`, as bare hex |
| `COMPILE_ARTIFACT_HASH` | the payload's `compileArtifactHash`, as bare hex |
| `LOGIC_MODEL_HASH` | R2's envelope hash, as bare hex. R6 checks it against the manifest's `snapshotHash` and echoes it into `references.logicModelHash` |
| `INPUT_HASH` | the bare model's hash. R6 checks it against the manifest's `inputHash` |
| `GOLDEN_CASES_FILE` | `/in/golden-cases.json`, only when the job has golden cases |
| `GOLDEN_CASES_HASH` | that file's hash, only when the job has golden cases |

Read-only mounts: `/project`, `/in` (`logic.json`, plus `golden-cases.json` when present) and
`/verifier`. `/verifier` has no `node_modules`; the harness comes from the image. Build it with
`scripts/build-verifier.sh`. The runner's copy of R6's report schema
(`runner/src/verification-report.schema.json`) must match the pinned commit, so update them together.

The two hashes stay separate. `LOGIC_MODEL_HASH` is the snapshot envelope. `INPUT_HASH` is the bare LogicModel. The runner passes each as bare hex.

### R2 alignment

On `integrate/compiler` these rows already match the runner:

| Item | What this branch does |
|---|---|
| Initial `JOB#/META` status | `PENDING`. The runner takes the job |
| `OUTBOX.payload` | The published `JobPayload` or `VerifyBuildPayload`, validated before the write |
| Verify `snapshotUri` | The compilation job's real snapshot object URI |
| `references.logicModelHash` | The runner passes the envelope hash as `LOGIC_MODEL_HASH` and the bare model as `INPUT_HASH` |
| Result fields | R2 reads the 1.1.0 fields, including version IDs, `compilerExitCode`, `chtConfStatus`, and `failureKind` |
| `checkReportHash` | The digest of the accepted checker report |
| Report schema | 2.3.0 |

Still open before a hosted job finishes end to end:

| Item | Contract | Next step |
|---|---|---|
| `job-events` | Pipe sends `{ requestId, jobId, status, attempt }`. `attempt` arrives as a numeric string | A consumer must call `JobCompletionReconciler`, converting `attempt` with `Number()`. The reconciler accepts that string and does not poll the queue |
| Service actors | Runner records `cht-runner-compile` and `cht-runner-verify` | Register both in `resolveServiceActor`, with the COMPILER and VERIFIER roles |
| Golden cases | Optional `goldenCasesUri` and `goldenCasesHash` | R2 adds them when it has an authoritative golden-case object. Without them, verification runs without golden cases and uses the evaluator |

Already aligned: approval records, `sha256:` prefix handling, and `TIMED_OUT` and `EXHAUSTED`, which R2 can read but the runner never writes. No real R2 job has gone through the runner yet.

### Pinned compiler commit

Branch `compiler` is pinned at **`7f488e6`** (moved from `b2c5fb1` once R5
landed the baseline diff and a working `templates/cht-base`). `TEMPLATE_DIR`
is `templates/cht-base` **as it exists at that same commit** — check out the
whole pinned commit (e.g. `git worktree add`), not just `packages/compiler`,
since the template lives at the repo root on that branch. The stage 3
convert command also changed: no `-- <formId>` — `cht --local
--skip-dependency-check --skip-git-check compile-app-settings
convert-app-forms validate-app-forms` runs project-wide now, so app settings
and `tasks.js` build too (see `build-image/run-convert.sh`).

## Local testing

`docker-compose.test.yml` runs DynamoDB Local (in-memory, port 8000) for
runner tests (section 7) and CI (section 13). `scripts/dynamodb-local/create-table.sh`
creates the table against it with the exact same keys/GSIs/stream setting as
`infra/terraform/dynamodb.tf`, so tests run against the real schema, not an
approximation. It's idempotent — safe to call on every test run.

```sh
docker compose -f docker-compose.test.yml up -d
./scripts/dynamodb-local/create-table.sh
# ... run tests against http://localhost:8000 ...
docker compose -f docker-compose.test.yml down -v
```
