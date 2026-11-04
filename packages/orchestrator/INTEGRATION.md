# R2 Orchestrator — Integration Guide

Everything a teammate needs to integrate with the Role 2 backend. The exact
cross-team payload/record contracts (hash identities, R6 schema, R7 job records)
live in [`CONTRACTS.md`](./CONTRACTS.md); this document is the operational API +
boundary reference. Every endpoint below is registered in `src/server.ts`.

## 1. Running the backend

Node 22 (>= 22.18; the app runs its TypeScript sources via type stripping).

```sh
cd packages/orchestrator
npm install --workspaces=false --no-package-lock --ignore-scripts   # isolated, no shared lockfile
npm start            # node --experimental-strip-types src/main.ts
```

Docker (Node 22, listens on 0.0.0.0:8080, graceful SIGTERM/SIGINT, /health):

```sh
docker build -t cht-nocode/orchestrator ./packages/orchestrator
docker run --rm -p 8080:8080 \
  -e MODE=aws -e AWS_REGION=us-west-2 \
  -e DDB_TABLE=... -e ARTIFACT_BUCKET=... \
  -e COGNITO_USER_POOL_ID=... -e COGNITO_CLIENT_ID=... \
  cht-nocode/orchestrator
```

Compose (R7 app-host): build context `./packages/orchestrator`, publish 8080,
pass the env vars below. The image embeds no secrets; AWS mode uses the instance
role and refuses to load demo identities.

### Environment variables

| Var | Mode | Meaning |
|---|---|---|
| `MODE` | both | `aws` or `local` (default `local`). |
| `AWS_REGION` | aws | Must be `us-west-2` (R7 hard constraint). |
| `DDB_TABLE` | both | DynamoDB table (`terraform output dynamodb_table_name`). |
| `ARTIFACT_BUCKET` | aws | S3 bucket (`terraform output artifact_bucket`). |
| `COGNITO_USER_POOL_ID` | aws | `terraform output cognito_user_pool_id`. |
| `COGNITO_CLIENT_ID` | aws | `terraform output cognito_user_pool_client_id`. |
| `R2_DYNAMODB_LOCAL_ENDPOINT` | local | Loopback DynamoDB Local URL. |
| `R2_OBJECT_DIR` | local | Directory backing the local object store (S3 stand-in). |
| `HOST` / `PORT` | both | Default `0.0.0.0` / `8080` (local defaults to `127.0.0.1`). |

Invalid/missing config fails closed at startup (AWS mode never falls back to
memory, local disk, or demo identities).

## 2. Authentication (R1)

Every `/api/*` route requires a **Cognito access token**:
`Authorization: Bearer <access token>`. R2 verifies the signature, issuer, user
pool, `client_id`, `token_use=access` and expiry via `aws-jwt-verify`, derives
roles from the verified `cognito:groups` claim, and maps the `sub` to the actor.
Nothing is read from the request body. Request-level access is authoritative:
the owner, or the reviewer whose queue currently holds the request.

Cognito groups → roles: `po`→PO, `service_designer`→SERVICE_DESIGNER,
`clinician`→CLINICIAN, `release_approver`→RELEASE_APPROVER, `developer`→ORCHESTRATOR.
Seed demo users with `scripts/seed-users.sh` (R7 branch).

`GET /health` is unauthenticated and returns `{ "status": "ok", "mode": "aws|local" }`.

## 3. R1 HTTP API

All bodies are JSON. Errors are `{ "error": { "code", "message", ... } }`.
`eventId` is the caller's idempotency key (a repeat with identical content is a
safe duplicate; reusing it with different content is rejected). `expectedVersion`
is optimistic concurrency — pass the workflow `version` you last saw; a stale
value returns 409.

| Method & path | Role | Body (key fields) | Success |
|---|---|---|---|
| `POST /api/requests` | PO | `{ eventId, expectedVersion: 0, content: { title, objective, targetPopulation, requirements[] } }` | 201 `{ requestId, workflowVersion, ... }` |
| `GET /api/requests/:id` | owner PO | — | 200 `{ requestId, status, version, preview, screening, confirmation, clinicalApprovalRequired }` |
| `POST /api/requests/:id/confirmations` | owner PO | `{ eventId, expectedVersion, revision, snapshotHash, screeningId, decision: CONFIRMED\|REVISION_REQUESTED }` | 200 |
| `POST /api/requests/:id/revisions` | owner PO (or SD/DRAFTER per state) | `{ eventId, expectedVersion, revision, snapshotHash, content }` | 200 |
| `GET /api/reviews/queue?category=SERVICE_DESIGNER\|CLINICAL\|RELEASE` | matching reviewer | — | 200 `{ category, items[] }` |
| `GET /api/requests/:id/review-context?category=...` | matching reviewer | `expectedVersion?` query | 200 review context (eligibility, snapshots, evidence refs) |
| `POST /api/requests/:id/clinical-decisions` | CLINICIAN | `{ eventId, expectedVersion, requestRevision, requestSnapshotHash, logicRevision, logicHash, checkerReportId, decision: APPROVE\|REJECT\|RETURN, note? }` | 200 |
| `POST /api/requests/:id/release-decisions` | RELEASE_APPROVER | `{ ...common, clinicalApprovalEventId, compilationId, artifactHash, verificationId, verificationReportHash, decision, note? }` | 200 |
| `GET /api/requests/:id/status` | member | — | 200 `{ requestId, status, version }` |
| `GET /api/requests/:id/artifact` | member | — | 200 released artifact ref (below), else 404 |

`note` is required for `REJECT`/`RETURN`. Decision responses:
`{ requestId, eventId, reviewType, decision, outcome, decisionRecorded, duplicate, workflowVersion, auditId }`.

**Released artifact** (`GET /api/requests/:id/artifact`) — only when the
workflow is `RELEASE_APPROVED`/`DOWNLOAD_READY`, else 404 (an unapproved artifact
is never exposed):
```json
{
  "requestId": "...", "status": "RELEASE_APPROVED", "released": true,
  "compilationId": "...", "artifactHash": "<64hex>", "manifestHash": "<64hex>",
  "verificationId": "...", "reportHash": "<64hex>",
  "package": { "uri": "s3://...", "versionId": "...", "sha256": "<64hex>", "size": N },
  "manifest": { ... }, "report": { ... }
}
```
R2 returns the reference only; byte delivery is R1/R7's concern.

Independence is enforced by the workflow, not the caller: a request's author
cannot clinically approve it; the clinician cannot be the release approver; the
verifier cannot be the compiler or the clinician.

## 4. Machine-to-machine boundaries (R3/R4/R5/R6/R7)

These are **not** public HTTP endpoints. They are in-process services exposed on
the object returned by `bootstrap()` (`services`), invoked by trusted callers
with a verified **service** identity (resolved to a worker-role actor —
DRAFTER/CHECKER/COMPILER/VERIFIER — via `WorkerPolicies.resolveServiceActor`,
never a browser Cognito session). Each service re-validates everything and fails
closed. The `bootstrap()` caller must supply `workers` policies; absent a
required one, that boundary fails closed.

### R3 — screening & drafting
- Handoff: R2 emits a `DRAFT_LOGIC` job (`services.draftingHandoff.start`) when
  the workflow is `READY_FOR_LOGIC_PROPOSAL` (ORCHESTRATOR).
- Callback: `services.draftingCallback.ingest(DraftingResultCommand, principal)`
  accepts R3's LogicModel (`LOGIC_PROPOSED`). Requires a real
  `WorkerPolicies.draftingValidation` (R4 validation boundary); fails closed
  without it. DRAFTER identity required.

### R4 — checker results
- `services.checkerResults.authorize(...)` then `.ingest(CheckerResultCommand, principal)`
  (`LOGIC_CHECKED`). Requires `WorkerPolicies.checkerTarget`. CHECKER identity.

### R5 — compilation (via R7)
- Handoff: `services.compilationHandoff.start(CompilationCommand, principal)` when
  `CLINICALLY_APPROVED` (ORCHESTRATOR) → emits `COMPILE_LOGIC` job + outbox, with
  a validated R7 `JobPayload` in `OUTBOX.payload` (real `snapshotUri` =
  the verified logic-model object URI, `checkReportHash` = SHA-256 of the canonical
  R4 checker report). Fails closed if the checker report is unavailable.
- Result: ingested through the **reconciler** (below). Requires
  `WorkerPolicies.authorizeCompilationRunner` + `compilationArtifacts` (R5 byte
  verifier). COMPILER identity.

### R6 — verification (via R7)
- Handoff: `services.verifyBuildHandoff.start(VerifyBuildCommand, principal)` when
  `WAITING_FOR_VERIFICATION` (ORCHESTRATOR) → emits `VERIFY_BUILD` job bound to the
  exact accepted compiled artifact (packageHash/manifestHash/compileArtifactHash),
  the real `snapshotUri` (the compile job's verified object URI) and
  `checkReportHash` (SHA-256 of the canonical R4 checker report JSON).
- Result: ingested through the reconciler. R2 fetches the report by
  `reportUri`/`reportHash`, byte-verifies it, validates against R6's v2.3.0 JSON
  Schema (top-level `schemaVersion` + `version` both `"2.3.0"`, nullable top-level
  `packageHash`, plus v2.3.0's new required `asOf` + `evaluator` provenance,
  `references.expectedCompileArtifactHash`, `coverage.coveredViaBlockedSubmission`),
  cross-checks references against R2 state, requires a non-null authoritative
  `packageHash` for a VERIFIED build, and requires `passed === true` AND
  `coverageComplete === true`. VERIFIER identity (independent of clinician/compiler).

### R7 — job delivery, status & the reconciler (the interface R7 must call)
- **Outbound (R2→R7):** R2 writes job intent + audit + an `OUTBOX` item in one
  DynamoDB transaction. `JOB#<jobId>/META` starts in R7's `status: "PENDING"` with
  the `gsi1pk`/`gsi1sk` attributes. For COMPILE_LOGIC/VERIFY_BUILD,
  `OUTBOX.payload` is EXACTLY R7's validated wire `JobPayload`/`VerifyBuildPayload`
  (no internal R2 intent fields); DRAFT_LOGIC has no R7 `JobPayload` and keeps the
  internal intent instead. R7's EventBridge Pipe forwards `OUTBOX.payload` to the
  `jobs` queue. R2 never sends SQS directly. Hashes are `sha256:`-prefixed at the
  wire; R2 emits `contractVersion "1.0.0"` (accepted by R7's 1.1.0 verifier).
- **Inbound (R7→R2):** when a job reaches a terminal status, R7's Events Pipe
  delivers `{ requestId, jobId, status, attempt }` (NO `jobType`) to `job-events`
  (or R2 polls). R7's queue consumer / poller then invokes
  **`services.reconciler.reconcile(notification, servicePrincipal)`**:
  ```ts
  reconcile(
    { requestId: string, jobId: string, jobType?: 'COMPILE_LOGIC'|'VERIFY_BUILD', attempt: number },
    servicePrincipal,   // resolves to a COMPILER (compile) or VERIFIER (verify) actor
  ): Promise<{ status: 'RECONCILED'|'DUPLICATE'|'STALE'|'BLOCKED'|'REJECTED'|'UNKNOWN_JOB'|'STORAGE_FAILURE', jobType, reason, workflowVersion }>
  ```
  `jobType` is optional and ignored as authority: the reconciler determines the
  real job type from R2's stored intent (`getCompilationJob`/`getVerifyBuildJob`),
  then re-reads the AUTHORITATIVE `JOB#<jobId>/META` record (R7 writes the
  `JobResult` flat there) via `src/r7-job-record.ts`, which adapts R7's flat fields
  into R2's execution shape and strips the `sha256:` prefix to raw hex. A
  non-terminal (`PENDING`/`RUNNING`) record yields `JOB_NOT_COMPLETED` and never
  invents a result. The DynamoDB finalization transaction conditions on R7's real
  `attempt`+`status`, so a stale attempt fails closed. The notification is only a
  hint of which job to reconcile; all evidence is the authoritative record + R2's
  stored intent.
- **Runner identities:** terminal META `runnerActorId`/`leaseOwner` values like
  `<worker>-compile` / `<worker>-verify` are mapped to COMPILER/VERIFIER by the
  injected `WorkerPolicies.authorize{Compilation,Verification}Runner` policy, never
  by parsing the suffix. Ingestion still enforces verifier ≠ compiler ≠ clinician.

See `CONTRACTS.md` for the two replaceable mirrored schemas (R6 report v2.3.0,
R7 COMPILE/VERIFY payloads at CONTRACT_VERSION 1.1.0) to swap for direct imports
after the integration merge, plus the golden-case handoff that remains R4/R7-owned.

## 5. Node 22 Docker

```sh
docker build -t cht-nocode/orchestrator ./packages/orchestrator
# local smoke:
docker run --rm --network host \
  -e MODE=local -e R2_DYNAMODB_LOCAL_ENDPOINT=http://localhost:8000 \
  -e DDB_TABLE=cht-nocode-local -e R2_OBJECT_DIR=/data/objects \
  -e PORT=8080 -v /tmp/r2-objects:/data/objects cht-nocode/orchestrator
curl localhost:8080/health      # {"status":"ok","mode":"local"}
```
Built and verified on `node:22.18.0`. SIGTERM/SIGINT → graceful shutdown (exit 0).

## 6. Tests to run

```sh
cd packages/orchestrator
npm run typecheck                 # 0 errors (strict, NodeNext)
npm test                          # unit suite
# with DynamoDB Local on :8000:
R2_DYNAMODB_LOCAL_ENDPOINT=http://localhost:8000 npm run test:dynamodb
R2_DYNAMODB_LOCAL_ENDPOINT=http://localhost:8000 \
  node --experimental-strip-types --test test/aws-auth.integration.test.ts test/bootstrap.integration.test.ts
```
DynamoDB Local: `docker run --rm -p 8000:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory -sharedDb`.
The assembled end-to-end scenario is `test/assembled.integration.test.ts`.

## 7. Known teammate-owned blockers

- **R6 report version sync — R2 is on v2.3.0; R7 verifier still on v2.2.0
  (teammate-owned).** R6 publishes VerificationReport v2.3.0 (`verification`
  @ `1bb8b1b`); R7's deployed verifier is still pinned to v2.2.0 and will re-pin to
  2.3.0 after this R2 v2.3.0 compatibility is confirmed. R2 validation is STRICT:
  it accepts ONLY 2.3.0 (and enforces `version === schemaVersion`, top-level
  `packageHash === references.packageHash`, and the new required `asOf`/`evaluator`/
  `expectedCompileArtifactHash`/`coveredViaBlockedSubmission`). Until R7 re-pins,
  a report the verifier emits at 2.2.0 will be rejected by R2 — the re-pin is the
  gating action. Tested against the real R6 schema at `1bb8b1b` (parity test in
  `test/verification-report.test.ts`).
- **R6 `references.logicModelHash` carries the bare inputHash, not R2's envelope
  hash (teammate-owned, R7↔R6).** R7 flagged that R6 currently echoes the bare
  LogicModel inputHash in `references.logicModelHash`, while R2's authoritative
  identity is the canonical snapshot-ENVELOPE hash. R2 deliberately KEEPS its
  envelope-hash cross-check and does not weaken it; R6 must change the echoed value
  to R2's envelope hash. Until then a real report fails R2's reference cross-check.
- **Golden cases handoff — R4/R7-owned.** R7's v1.1.0 payload adds optional
  `goldenCasesUri`/`goldenCasesHash` (both-or-neither). R2 has no authoritative
  uploaded golden-case object reference (golden hashes appear only inbound in R6
  reports), so R2 OMITS both fields and never fabricates them. Propagating the real
  22 child-cough golden cases (`fixtures/child-cough/golden-cases.json`) requires
  R4/R7 to own the immutable upload and hand R2 the exact object URI + SHA-256 of
  the uploaded bytes through a trusted boundary. That handoff does not yet exist.
- **`checkReportHash` source (confirmed with R7).** R7 records the job payload's
  `checkReportHash` as the SHA-256 of the canonical R4 checker report JSON. R2
  derives it from the accepted `AcceptedCheckerResult.report` (`checkerReportHash`),
  NOT from `compileArtifactHash`/`checkerReportId`, and fails closed if the checker
  report is unavailable or does not bind the exact logic.
- **R7 flat JOB/META vs recordVersion:** R7's META has `attempt`+`status` but no
  `recordVersion`. R2 adapts (synthesizing `r7-attempt-<n>`) and conditions on
  `attempt`+`status`. R7 must ensure the terminal META carries the fields R2 reads
  (compile: `packageHash/packageUri/packageVersionId`, `manifestHash/Uri/VersionId`,
  `compileReportUri/Hash/VersionId`, `compileArtifactHash`, `inputHash`,
  `toolVersions`, `leaseOwner`, `startedAt`/`finishedAt`; verify: `reportUri/Hash/VersionId`,
  `verificationPassed`, `coverageComplete`, `reportVersion`).
- **Shared schemas unmerged:** `packages/schema` (R7) and `packages/verification`
  (R6) are not on this branch; R2 uses labelled replaceable mirrors (CONTRACTS.md).
- **Worker/service identities:** R7 must provide the service-identity resolution
  and runner authorization policies (`WorkerPolicies`) that map R3/R4/R5/R6/R7
  service principals to worker roles; R2 fails closed without them.
- **R3/R4/R5/R6 processing:** R2's local tests use fictional fixtures for teammate
  processing; real R3 drafting, R4 checking, R5 compilation and R6 verification
  are integrated at team assembly time.
