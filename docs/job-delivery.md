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
  `INSERT` where `sk = OUTBOX` → the `jobs` SQS queue, sending the payload
  stored on the outbox item.
- **Events Pipe** (Tier 3): DynamoDB Stream → EventBridge Pipe, filtered to
  `MODIFY` on `sk = META` items where `status` changed → the `job-events`
  queue, sending `{ jobId, status, attempt }`.

**Fallbacks if Pipes don't work out** (ask R7 before switching): a poller in
the orchestrator for the outbox (runner idempotency makes duplicate sends
safe), and R2 polling job status instead of consuming events.

## Lease, retry and failure behavior (section 7)

1. **Receive** from `jobs` (long polling). Payload fails schema validation →
   fail the job with `errorCode = INVALID_PAYLOAD`.
2. **Take the job** in one `TransactWriteItems`: write a receipt keyed by the
   SQS message ID (`attribute_not_exists(pk)` guards duplicates), flip
   `JOB#<jobId>/META` to `RUNNING` with `leaseOwner`/`leaseUntil`/`attempt`,
   conditioned on `status = PENDING OR (status = RUNNING AND leaseUntil <
   now)`. Condition failure = someone else already owns it; delete the SQS
   message and stop.
3. **Heartbeat** every `LEASE_SECONDS / 3`: extend `leaseUntil` (conditional
   on `leaseOwner` + `attempt`) and extend the SQS visibility timeout.
4. **Second guard** (mode = `approved` only): the referenced
   `APPROVAL#<clinicalApprovalId>` must exist, be `decision = approved`,
   match `logicModelHash`, and not be superseded. Otherwise
   `errorCode = APPROVAL_INVALID`.
5. **Terminal vs. retryable failure:**
   - Compiler exit 1 (`MODEL_REJECTED`), `cht` convert/validate rejection
     (`CONVERT_FAILED`), hash mismatches (`HASH_MISMATCH`,
     `INPUT_HASH_MISMATCH`) → **terminal `FAILED`**, no retry.
   - Compiler exit 2, infra errors during convert, or timeout
     (`COMPILE_INFRA_ERROR`) → **retryable**: one transaction resets the job
     to `PENDING` and clears the lease, plus an `attempt_failed_retryable`
     audit event; SQS visibility is set to 30s (message is not deleted) so
     it's redelivered.
   - After `maxReceiveCount = 3`, SQS moves the message to `jobs-dlq`. The
     DLQ reconciler (section 10, later) marks it `FAILED` /
     `DELIVERY_EXHAUSTED`.
   - A lease that expires with `attempt >= 3` and no reconciler action yet is
     swept to `FAILED` / `LEASE_EXPIRED`.
6. **Commit the result** in one `TransactWriteItems`: update
   `JOB#<jobId>/META` with the final status + result fields, conditioned on
   `leaseOwner = WORKER_ID AND attempt = <n> AND status = RUNNING`, plus an
   audit event. Then delete the SQS message. A job is never left silently
   `RUNNING` — every path (success, terminal failure, or error) commits a
   result.

## Result fields

`JobResult` (full shape in `packages/schema/src/handoffs.ts`) carries, at
minimum: `jobId`, `jobType`, `attempt`, `status` (`SUCCEEDED`/`FAILED`), the
hash chain for that build
(`logicModelHash`/`snapshotHash`/`inputHash`/`compileArtifactHash`/
`templateHash`/`manifestHash`/`packageHash`), `toolVersions` (image digests,
compiler/verifier commits, model ID), `startedAt`/`finishedAt`,
`errorCode`/`errorMessage` (both `null` on success), and `logUri`. A
`VERIFY_BUILD` result additionally carries `reportUri`/`reportHash`/
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
