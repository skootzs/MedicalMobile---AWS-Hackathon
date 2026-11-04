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
| R7 job payloads/results | `src/r7-handoff-contract.ts` (COMPILE_LOGIC + VERIFY_BUILD payloads) | `packages/schema/src/handoffs.ts` @ `r7-infra` 9a61462, CONTRACT_VERSION `1.1.0` | import R7's `jobPayloadSchema`/`verifyBuildPayloadSchema` + `validateJobPayload`/`validateVerifyBuildPayload` |
| R6 VerificationReport | `src/verification-report-contract.ts` | `packages/verification/src/verification-report.schema.json` @ `verification` 1bb8b1b, schemaVersion `2.3.0` | import R6's schema JSON |

**Contract-version choice (R7):** R7's `ACCEPTED_PAYLOAD_VERSIONS = ['1.0.0','1.1.0']`
and 1.1.0 only ADDS optional fields (`goldenCasesUri`/`goldenCasesHash`). R2 emits
`contractVersion "1.0.0"` deliberately (it owns no authoritative golden-case object
reference), and R2's mirror validators accept both versions. This is a
forward-compatible choice, not a stale value.

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
  LogicModel + clinical approval. The `OUTBOX.payload` is R7's validated
  `JobPayload` (`toCompilePayload`): real `snapshotUri` (the verified logic-model
  object URI), and `checkReportHash` = SHA-256 of the canonical R4 checker report
  JSON (`checkerReportHash`), never `compileArtifactHash`. The handoff fails
  closed if the checker report is unavailable or does not bind the exact logic.
- R2 ingests the compilation result (`src/compilation-results.ts`), re-verifying
  the compiled artifact (manifest/package/report object digests, generated-files
  hash, input hash) via a trusted `CompilationArtifactVerifier` before `COMPILED`.
- R5/R7 must provide: a `COMPILER`-role runner identity; an authoritative R7
  JOB/META execution record (conditioned in R2's transaction); immutable S3
  objects for package/manifest/report with versionIds.

## R6 — verification jobs & reports

- R2 emits a `VERIFY_BUILD` job after an accepted compilation
  (`src/verify-builds.ts`, `src/verify-build-contracts.ts`) on `START_VERIFICATION`,
  binding `compileJobId` + `packageHash` + `manifestHash` + `compileArtifactHash`
  + package object URI/version (read from the accepted `CompilationResultRecord`),
  the **real** `snapshotUri` (the compile job's verified logic-model object URI),
  and `checkReportHash` (SHA-256 of the canonical R4 checker report JSON). The
  `OUTBOX.payload` is R7's validated `VerifyBuildPayload`.
- R2 ingests the verification result (`src/verification-results.ts`): it fetches
  the immutable report by `reportUri`/`reportHash`, **byte-verifies** it against
  `reportHash`, **schema-validates** the whole document against R6's v2.3.0 schema
  (required top-level `schemaVersion` and `version`, both `"2.3.0"`, a nullable
  top-level `packageHash` promoted from `references.packageHash`, and v2.3.0's new
  required top-level `asOf` + `evaluator` provenance, `references.
  expectedCompileArtifactHash`, and `coverage.coveredViaBlockedSubmission`),
  cross-checks the report's echoed `references` (logicModelHash, clinicalApprovalId,
  compilationJobId, packageHash) and `compileArtifactHash` against R2's authoritative
  identities, asserts `version === schemaVersion` and top-level `packageHash ===
  references.packageHash`, requires a non-null authoritative `packageHash` for a
  VERIFIED build, and requires `passed === true` AND `coverageComplete === true`
  before emitting `VERIFIED`. The accepted record carries the report's
  `reportVersion` (`report.schemaVersion`) verbatim. Anything else emits `FAIL`;
  integrity failures are rejected. A stale R7 verify-attempt cannot advance
  (conditioned in the Dynamo transaction).
- **R6↔R2 hash distinction (teammate-owned fix):** R7 reported that R6's
  `references.logicModelHash` currently carries the bare LogicModel inputHash
  rather than R2's canonical snapshot-envelope hash; R7 is coordinating that fix
  with R6. R2 **keeps** its authoritative envelope-hash comparison and does not
  weaken it to accept the inputHash. Until R6 ships the fix, a report whose
  `references.logicModelHash` is the bare inputHash will (correctly) fail R2's
  cross-check.
- **Version pinning (teammate-owned):** R6 is at report v2.3.0; R7's deployed
  verifier is still pinned to v2.2.0 and will re-pin to 2.3.0 after this R2
  v2.3.0 compatibility is confirmed. R2 validation is strict: it accepts ONLY
  2.3.0 and rejects 2.2.0/2.1.0. The R7 verifier must emit 2.3.0 for ingestion
  to accept the report.
- R6 must provide: a `VERIFIER`-role identity (independent of the clinician and
  the compiler); a VerificationReport conforming to schemaVersion `2.3.0`; the
  report stored as an immutable S3 object with a versionId; `goldenCasesHash`
  non-null when golden cases apply (R2 surfaces it but does not substitute it).

### Golden cases (teammate-owned handoff)

R7's v1.1.0 payload adds optional `goldenCasesUri`/`goldenCasesHash` (both-or-
neither). The integrated repo has 22 child-cough golden cases at
`fixtures/child-cough/golden-cases.json`, but **R2 owns no authoritative uploaded
golden-case object reference** — golden-case hashes appear only INBOUND in R6
reports. R2 therefore **omits both fields** from the payload (schema-valid; they
are optional) and never fabricates a URI/hash. Propagating a real
`goldenCasesUri`/`goldenCasesHash` requires R4/R7 to own the immutable upload of
the approved golden-cases file and hand R2 the exact object URI + SHA-256 of the
uploaded bytes through a trusted integration boundary; that handoff does not yet
exist.

## R7 — authoritative job status & outbox delivery

- R2 writes job intent + audit + `OUTBOX` in ONE DynamoDB transaction
  (`src/storage/dynamodb.ts`); R7's EventBridge Pipe delivers the `OUTBOX.payload`
  to the jobs queue. R2 never sends SQS directly.
- **Job delivery shape (R7 v1.1.0 / 9a61462):** `JOB#<jobId>/META` starts in
  R7's `status: "PENDING"` with the `gsi1pk`/`gsi1sk` attributes. For COMPILE_LOGIC
  and VERIFY_BUILD, `JOB#<jobId>/OUTBOX.payload` contains EXACTLY the validated R7
  wire `JobPayload`/`VerifyBuildPayload` (no internal R2 intent fields). DRAFT_LOGIC
  precedes any LogicModel (it has no `logicModelHash`/`snapshotUri`), so it carries
  no R7 `JobPayload`; its outbox keeps the internal intent for R2/R3-internal
  delivery. R2 fails closed if a COMPILE/VERIFY payload would not validate.
- **Job events (R7 Tier 3):** the events queue delivers `{requestId, jobId,
  status, attempt}` with NO `jobType`. R2's reconciler (`src/reconciler.ts`) treats
  the notification as a hint only: it re-reads R2's authoritative stored intent to
  determine the job type, re-reads the authoritative `JOB#<jobId>/META`, and
  reconciles only the current terminal attempt (the Dynamo condition cancels a
  stale attempt). Non-terminal/`PENDING`/`RUNNING` events never invent a result.
- **Runner identities:** terminal JOB/META carries `runnerActorId`/`leaseOwner`
  values like `<worker>-compile` / `<worker>-verify`. R2 maps these verified
  service identities to `COMPILER`/`VERIFIER` roles through the injected
  machine-to-machine `authorizeRunner` policy (bootstrap `workers.*`), NOT by
  parsing the string suffix. Compiler/verifier separation and approval-
  independence (verifier ≠ clinician ≠ compiler) are enforced in ingestion.
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
`sha256:` **only** at the outgoing job-payload boundary (`toCompilePayload` /
`toVerifyBuildPayload` / `toR7Hash` in `src/r7-wire.ts`,
`src/compilation-contracts.ts`, `src/verify-build-contracts.ts`). Internal
identities and workflow guards are never changed; R7's flat JOB/META hashes are
stripped back to raw hex at `rawHex()` in `src/r7-job-record.ts`. R6's report
hashes are raw hex, matching R2 directly. See `docs/job-delivery.md` (R7) which
explicitly leaves the prefix decision to R2 and says "compare hex parts either
way".
