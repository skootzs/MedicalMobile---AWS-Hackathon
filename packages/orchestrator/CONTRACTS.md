# Role 2 (orchestrator) cross-team integration contracts

R2 owns authoritative workflow orchestration, routing, reviewer queues,
version-bound approvals, immutable snapshots, DynamoDB persistence, Cognito auth,
S3 storage, R3/R4/R5/R6 job handoffs + result ingestion, audit, idempotency and
release gates. This file documents every integration boundary and exactly what
each teammate must provide. Shapes marked **(replaceable boundary)** mirror a
teammate schema from an unmerged branch and must be swapped for a direct import
once that branch merges.

## Shared-schema boundaries that are not yet importable

| Boundary | Local file | Authoritative source | Replace on merge |
|---|---|---|---|
| R7 job payloads/results | `src/r7-handoff-contract.ts` (VerifyBuildPayload only) | `packages/schema/src/handoffs.ts` @ `r7-infra` 6f7e8b1, CONTRACT_VERSION `1.0.0` | import R7's `verifyBuildPayloadSchema` / `validateVerifyBuildPayload` |
| R6 VerificationReport | `src/verification-report-contract.ts` | `packages/verification/src/verification-report.schema.json` @ `integrate/compiler` 99001e8, schemaVersion `2.2.0` | import R6's schema JSON |

Both are small, clearly-labelled mirrors validated with Ajv. R2 does not create a
competing permanent schema.

## R1 — request, review, approval, release & artifact APIs (inbound HTTP)

R1 calls these authenticated routes (Cognito access token as `Authorization:
Bearer`). R2 derives roles from verified `cognito:groups`; nothing is trusted
from the body.

- `POST /api/requests` — PO creates a request.
- `GET /api/requests/:id` — owner-only intake view.
- `POST /api/requests/:id/confirmations` | `/revisions` — PO confirm / revise.
- `GET /api/reviews/queue?category=SERVICE_DESIGNER|CLINICAL|RELEASE` — reviewer inbox.
- `GET /api/requests/:id/review-context?category=...` — reviewer detail.
- `POST /api/requests/:id/clinical-decisions` — clinician APPROVE/REJECT/RETURN.
- `POST /api/requests/:id/release-decisions` — release approver APPROVE/REJECT/RETURN.
- `GET /api/requests/:id/status` — `{requestId,status,version}`.
- `GET /api/requests/:id/artifact` — **released artifact reference**, only when
  the workflow is `RELEASE_APPROVED`/`DOWNLOAD_READY`; otherwise 404. Returns the
  bound `compilationId`/`artifactHash`(=packageHash)/`manifestHash`/
  `verificationId`/`reportHash` plus the immutable S3 object refs (package,
  manifest, report). It never streams bytes or mints a URL — R1/R7 own delivery.
- `GET /health` — unauthenticated liveness (`{status,mode}`).

R1 must provide: a valid Cognito access token per request; the PO/clinician/
release-approver users seeded into the Cognito groups (`scripts/seed-users.sh`).

## R3 — screening & logic drafting (handoff + authenticated callbacks)

- R2 emits a `DRAFT_LOGIC` job intent (`src/job-intents.ts`) + outbox on
  `START_LOGIC_PROPOSAL`; R7 delivers it. R3 produces screening and the LogicModel.
- R2 ingests the authenticated drafting callback (`src/callbacks.ts`,
  `LOGIC_PROPOSED`) and the screening/confirmation workflow events.
- R3 must provide: a `DRAFTER`-role service identity; a LogicModel snapshot whose
  bytes hash to the declared `logicHash` (R2 stores the canonical envelope at
  `snapshots/<logicHash>.json`); preserved unresolved findings.

## R4 — checker results (authenticated ingestion)

- R2 authorizes a checker invocation then ingests the result (`src/checkers.ts`,
  `LOGIC_CHECKED`), binding the exact model revision/hash + report id.
- R4 must provide: a `CHECKER`-role identity; a deterministic checker report bound
  to the exact LogicModel; the canonical hash coverage R2 already uses
  (`jcs-sha256-v1`, raw 64-hex).

## R5 — compilation jobs & results

- R2 emits a `COMPILE_LOGIC` job intent + outbox on `START_COMPILATION`
  (`src/compilations.ts`, `src/compilation-contracts.ts`), binding the approved
  LogicModel + clinical approval.
- R2 ingests the compilation result (`src/compilation-results.ts`), re-verifying
  the compiled artifact (manifest/package/report object digests, generated-files
  hash, input hash) via a trusted `CompilationArtifactVerifier` before `COMPILED`.
- R5/R7 must provide: a `COMPILER`-role runner identity; an authoritative R7
  JOB/META execution record (conditioned in R2's transaction); immutable S3
  objects for package/manifest/report with versionIds.

## R6 — verification jobs & reports (NEW this milestone)

- R2 emits a `VERIFY_BUILD` job after an accepted compilation
  (`src/verify-builds.ts`, `src/verify-build-contracts.ts`) on `START_VERIFICATION`,
  binding `compileJobId` + `packageHash` + `manifestHash` + `compileArtifactHash`
  + package object URI/version (read from the accepted `CompilationResultRecord`).
  The outgoing payload is validated against R7's `VerifyBuildPayload` schema.
- R2 ingests the verification result (`src/verification-results.ts`): it fetches
  the immutable report by `reportUri`/`reportHash`, **byte-verifies** it against
  `reportHash`, **schema-validates** the whole document against R6's v2.2.0 schema
  (required top-level `schemaVersion` and `version`, both `"2.2.0"`, plus a
  nullable top-level `packageHash` promoted from `references.packageHash`),
  cross-checks the report's echoed `references` (logicModelHash, clinicalApprovalId,
  compilationJobId, packageHash) and `compileArtifactHash` against R2's authoritative
  identities, asserts `version === schemaVersion` and top-level `packageHash ===
  references.packageHash`, requires a non-null authoritative `packageHash` for a
  VERIFIED build, and requires `passed === true` AND `coverageComplete === true`
  before emitting `VERIFIED`. Anything else emits `FAIL`; integrity failures are
  rejected. A stale R7 verify-attempt cannot advance (conditioned in the Dynamo
  transaction).
- R6 must provide: a `VERIFIER`-role identity (independent of the clinician and
  the compiler); a VerificationReport conforming to schemaVersion `2.2.0`; the
  report stored as an immutable S3 object with a versionId; `goldenCasesHash`
  non-null when golden cases apply (R2 surfaces it but does not substitute it).

## R7 — authoritative job status & outbox delivery

- R2 writes job intent + audit + `OUTBOX` in ONE DynamoDB transaction
  (`src/storage/dynamodb.ts`); R7's EventBridge Pipe delivers the `OUTBOX.payload`
  to the jobs queue. R2 never sends SQS directly.
- R7 owns the single table (`cht-nocode`, keys pk/sk, GSI1/GSI2, stream), the
  artifact S3 bucket (prefixes `snapshots/ builds/ previews/ sources/`, no delete),
  the Cognito pool/client/groups, and the compile/verify runners.
- R7 must provide: `terraform output` values for `DDB_TABLE`, `ARTIFACT_BUCKET`,
  `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` (region fixed `us-west-2`); the EC2
  instance role; the JOB/META execution records R2 conditions its result
  transactions on.

## Hash representation reconciliation (R2 raw-hex vs R7 `sha256:`)

R2 stores and compares **raw 64-hex** internally everywhere (`snapshotHash`,
`logicModelHash`, `packageHash`, `manifestHash`, ...). R7's wire contract uses a
`sha256:`-prefixed form (`^[A-Za-z0-9:_-]{8,128}$`). R2 converts raw-hex →
`sha256:` **only** at the outgoing job-payload boundary
(`toVerifyBuildPayload`/`toR7Hash` in `src/verify-build-contracts.ts`). Internal
identities and workflow guards are never changed. R6's report hashes are raw hex,
matching R2 directly. See `docs/job-delivery.md` (R7) which explicitly leaves the
prefix decision to R2 and says "compare hex parts either way".
