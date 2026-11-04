# DesignBrief eligibility gate and Routing Box

Run fictional unit tests without installing dependencies:

```sh
cd /Users/vivi/Documents/Codex/2026-11-03/hel/work/packages/orchestrator
npm test
```

Runtime tests were verified with Node.js v24.18.0. Static checking is configured
separately with TypeScript 5.9.3 and Node.js 22 type definitions. Running the tests
on the team's actual Node.js 22 runtime remains a separate verification step.
No shared configuration was changed.

## Static TypeScript checking

Run from this package with its declared dependencies installed (see the package-only
installation notes in the snapshot section below):

```sh
npm run typecheck
npm test
```

The package declares exact development-only versions of `typescript` (5.9.3) and
`@types/node` (22.20.1). These are tooling dependencies, not AWS integrations.
The standalone `tsconfig.json` checks all `src/**/*.ts` and `test/**/*.ts` files
without extending the empty shared root configuration. It enables `strict`, uses
NodeNext ESM resolution, ES2022 language/library definitions and Node 22 APIs,
allows the existing `.ts` import extensions, and restricts TypeScript syntax to
erasable forms compatible with Node's type stripping. `noEmit` prevents generated
JavaScript. Library declaration files are checked too; `skipLibCheck` is not enabled.
This does not replace runtime validation of untrusted data or authorization.

For the initial verification, the pinned compiler and Node 22 types were installed
in an isolated directory under `/private/tmp`, with no repository `node_modules`
or lockfile created. The compiler's `.bin` directory was temporarily added to
`PATH`, and `npm run typecheck -- --typeRoots <tool-directory>/node_modules/@types`
selected those exact Node types. No machine-specific paths are saved in the config.
That temporary tool installation was not a reproducible team dependency installation.
The snapshot milestone below now installs the declared dependencies locally, allowing
plain `npm run typecheck` to run without temporary PATH/typeRoots overrides.

The repository has an empty root `package.json`, an empty `pnpm-workspace.yaml`,
and no lockfile. pnpm currently fails on the empty root manifest. Agree on the
package manager/version, shared lockfile owner, and workspace installation process
before a normal workspace installation. The isolated package-only installation below
does not change the shared files. Do not create a package-local
npm lockfile as a substitute for an agreed team workspace lockfile.

## Ownership and input contract

All contracts in `src/routing.ts` are provisional and local to this package.
Initial AI screening and the intake UI belong to other workstreams. This module
only validates their evidence and computes a decision.

`routeDesignBrief(input)` accepts an internal `RoutingInput` envelope containing:

- `currentRevision`: the authoritative current `requestId`, `revision`, and
  `snapshotHash`, loaded independently of the submitted evidence.
- `currentScreeningId`: the authoritative selected screening attempt.
- `brief`: the same identity plus `title`, `objective`, `targetPopulation`, and
  condition/action `requirements`.
- `screening`: the same identity, `screeningId`, status (`PENDING`, `COMPLETED`,
  or `FAILED`), and all five assessment areas: `completeness`, `ambiguities`,
  `contradictions`, `clinicalSafety`, and `feasibility`.
- `confirmation`: the same identity, `confirmationId`, the applicable
  `screeningId`, and a decision (`CONFIRMED` or `REVISION_REQUESTED`).

Each screening area has an `outcome` and explicit `reasons` array:

- `CLEAR` requires an empty reasons array.
- `NEEDS_REVIEW` requires at least one non-empty unresolved concern.
- `NOT_ASSESSED` blocks eligibility, even if screening says `COMPLETED`.

Unknown assessment areas/outcomes or inconsistent outcome/reason combinations
block eligibility. Input is expected to be ordinary JSON data, not executable
objects or proxies. IDs are non-empty strings without outer whitespace. Revision
numbers are positive safe integers. Hashes must be 64 lowercase hexadecimal digits.

## Eligibility before routing

| Result | Meaning |
| --- | --- |
| `NOT_READY` | Missing, malformed, stale, failed, incomplete, unconfirmed, or conflicting evidence. Do not create a Service Designer task. |
| `NEEDS_SD_REVIEW` | Prerequisites are valid and current, but completed screening reports concerns or local structural checks find missing workflow content or contradictory actions. |
| `READY_FOR_BEDROCK_REVIEW` | Prerequisites are valid and current, all five checks are clear, and local structural checks find no concerns. |

Invalid prerequisites take precedence over concerns: a clinical finding plus a
missing PO confirmation is `NOT_READY`, not an automatically created SD task.

Results include the current revision identity, evidence record IDs, structured
reason codes/field locations/messages, and `clinicalApprovalRequired: true`.
Missing/invalid identity fields are returned as `null`; no IDs or hashes are invented.
An evidence ID in a blocked result is diagnostic, not proof the evidence was accepted.

The function creates no queues, jobs, state transitions, model calls, or audit
writes. A returned route never automatically starts downstream review. Future
workflow code must explicitly decide and record the next action.

## Trust and snapshot identity

This is NOT an endpoint accepting browser-provided proof. Future server code must
load current pointers, screening, and PO confirmation from authoritative storage,
authenticate who may write them, and validate model output before recording a
completed screening. Matching hashes alone do not establish authenticity.
A browser `trusted: true` flag is not evidence. This pure module cannot enforce
authentication, verify the actual snapshot bytes, or discover omitted records.

The brief, screening, and PO confirmation must all match the authoritative current
identity exactly. Confirmation must reference the selected screening attempt.
Even mutually consistent old evidence fails if the authoritative current revision
has advanced. Multiple candidate records are not accepted in place of a selected
record; future storage code must resolve the authoritative attempt explicitly.

Production hashing is not implemented. The schema and intake teammates must agree
on canonical snapshot serialization and hash coverage. Tests use fixed fictional
64-character fingerprints. Initial screening must cover the final proposed snapshot
shown to the PO. Any content edit needs a new revision, screening, and confirmation.
Records should remain immutable; finding resolution must not erase old concerns.

## Clinical safety and limitations

Preliminary AI screening and PO confirmation are not clinical approval. Bedrock
Guardrails safety controls are also distinct from substantive screening.
Service Designers may clarify workflow requirements but cannot waive clinical
approval. Any clinical safety concern needs appropriate human clinical review
before final release. Independent clinician approval, developer verification,
and release approval remain mandatory later, including when all AI checks are clear.
The result's constant clinical-approval requirement is a reminder, not an implemented
approval gate; later workflow/authentication/storage code must enforce it and preserve
clinical concern history across revisions.

Local checks retain required workflow fields and same-condition/different-action
conflict detection. Whitespace is normalized for comparisons, but case is preserved
so identifiers such as `fieldA` and `fielda` are not silently equated. The router
cannot understand clinical prose or prove feasibility or semantic consistency.
Reported concerns are preserved with their assessment field and message.

## Integration decisions still needed

Agree the provisional field names, positive revision numbering, hash format and
canonical snapshot coverage; the selected-screening pointer and retry policy;
how PO identities and permissions are recorded; and finding resolution/clinical
escalation ownership. The shared-schema owner controls any eventual shared types.
Storage placeholders remain under `src/storage`; no storage package is created.

The pure `workflow.ts` transition function described below consumes routing results
without treating a route as an approval or starting external work.

## Pure authoritative workflow (provisional R2 milestone)

`src/workflow.ts` exports `transitionWorkflow(state, event)`. Pass `null` and a
`SUBMIT` event to create a workflow. It returns `ACCEPTED`, `REJECTED`, or
`DUPLICATE`, a new state (or the unchanged state), and a proposed audit event.
Events and stored state are internal backend contracts, not browser payloads.

```mermaid
stateDiagram-v2
    [*] --> WAITING_FOR_SCREENING: PO SUBMIT
    WAITING_FOR_SCREENING --> WAITING_FOR_PO_CONFIRMATION: R3 SCREENING_COMPLETED
    WAITING_FOR_PO_CONFIRMATION --> READY_TO_ROUTE: owning PO confirms exact preview
    WAITING_FOR_PO_CONFIRMATION --> RETURNED_FOR_CLARIFICATION: PO requests corrections
    READY_TO_ROUTE --> READY_TO_ROUTE: NOT_READY rejected; no advancement
    READY_TO_ROUTE --> NEEDS_SD_REVIEW: apply eligible SD route
    READY_TO_ROUTE --> READY_FOR_LOGIC_PROPOSAL: apply eligible AI route
    NEEDS_SD_REVIEW --> WAITING_FOR_SCREENING: SD revises request
    READY_FOR_LOGIC_PROPOSAL --> DRAFTING_LOGIC: explicit START_LOGIC_PROPOSAL
    DRAFTING_LOGIC --> WAITING_FOR_LOGIC_CHECKS: R3 LOGIC_PROPOSED
    WAITING_FOR_LOGIC_CHECKS --> WAITING_FOR_CLINICAL_APPROVAL: R4 checks pass
    WAITING_FOR_CLINICAL_APPROVAL --> CLINICALLY_APPROVED: independent clinician approves LogicModel
    CLINICALLY_APPROVED --> COMPILING: explicit START_COMPILATION
    COMPILING --> WAITING_FOR_VERIFICATION: R5 returns bound artifact
    WAITING_FOR_VERIFICATION --> VERIFYING: explicit START_VERIFICATION
    VERIFYING --> WAITING_FOR_RELEASE_APPROVAL: R6 passes compiled artifact
    WAITING_FOR_RELEASE_APPROVAL --> RELEASE_APPROVED: independent release decision
    RELEASE_APPROVED --> DOWNLOAD_READY: explicit MAKE_DOWNLOAD_AVAILABLE
    WAITING_FOR_CLINICAL_APPROVAL --> RETURNED_FOR_CLARIFICATION: clinician returns with note
    WAITING_FOR_RELEASE_APPROVAL --> RETURNED_FOR_CLARIFICATION: release reviewer returns with note
    WAITING_FOR_CLINICAL_APPROVAL --> REJECTED: clinician rejects with note
    WAITING_FOR_RELEASE_APPROVAL --> REJECTED: release reviewer rejects with note
    WAITING_FOR_LOGIC_CHECKS --> FAILED: checks fail
    VERIFYING --> FAILED: verification fails
    COMPILING --> FAILED: compiler FAIL event
    DRAFTING_LOGIC --> FAILED: drafter FAIL event
    WAITING_FOR_SCREENING --> FAILED: screening worker FAIL event
    RETURNED_FOR_CLARIFICATION --> WAITING_FOR_SCREENING: request revision
    RETURNED_FOR_CLARIFICATION --> WAITING_FOR_LOGIC_CHECKS: LogicModel revision when one exists
    REJECTED --> WAITING_FOR_LOGIC_CHECKS: new LogicModel revision
    FAILED --> WAITING_FOR_SCREENING: new request revision
```

The diagram shows the main paths. `FAIL` also applies while waiting for R4 checks
and during verification. Any owning-PO request revision resets all later evidence,
including after download readiness. An R3 LogicModel revision, once a model exists,
returns to checks and clears clinical approval and all build/release evidence.
A request revision can also recover a rejected request. Recovery is deliberately
conservative: this version has no same-input retry or approval-waiver command.
An applicable new content revision is required to recover from a stopped state.

### State meanings

| States | What they mean |
| --- | --- |
| `WAITING_FOR_SCREENING`, `WAITING_FOR_PO_CONFIRMATION` | Waiting for R3 screening, then the owning PO's interpretation confirmation. Neither grants clinical approval. |
| `READY_TO_ROUTE`, `NEEDS_SD_REVIEW`, `READY_FOR_LOGIC_PROPOSAL` | Evaluate the existing router result; retain concerns for an SD or permit an explicit proposal-start command. `NOT_READY` is a rejected transition, not SD work. |
| `DRAFTING_LOGIC`, `WAITING_FOR_LOGIC_CHECKS` | R3 prepares a LogicModel; R4 checks that exact model revision and hash. |
| `WAITING_FOR_CLINICAL_APPROVAL`, `CLINICALLY_APPROVED` | A clinician independent of contributors reviews the exact checked model. Approval unlocks a separate compilation-start command. |
| `COMPILING`, `WAITING_FOR_VERIFICATION`, `VERIFYING` | Track a compile attempt and actual artifact, then a distinct verification run with a version-bound report. |
| `WAITING_FOR_RELEASE_APPROVAL`, `RELEASE_APPROVED`, `DOWNLOAD_READY` | A separate release approver accepts the exact passing artifact/report; a separate command marks availability. No actual URL or download is created. |
| `RETURNED_FOR_CLARIFICATION`, `REJECTED`, `FAILED` | Progress is stopped. Reviewer returns/rejections require notes; worker failures record the stopped stage. Applicable revisions restart the required checks. |

### Identity, approval and revision guards

- Every event includes the current request ID, preview revision, snapshot hash,
  an event ID, actor, and expected workflow state version. Initial revision is 1.
- R3 screening and owning-PO confirmation bind to that exact preview and screening
  attempt. Screening validation reuses the router with an internal validation-only
  confirmation placeholder. That placeholder is never recorded as confirmation;
  only an accepted owning-PO `PO_DECISION` supplies the real record.
- `APPLY_ROUTING` consumes the existing `RoutingResult` and compares it to the
  existing router's result over the stored records. It does not reimplement the
  routing checks. `NOT_READY` leaves state unchanged; no SD task is created.
- LogicModel identity has a separate positive `logicRevision` and SHA-256
  `logicHash`. R4 checks and clinician approval bind to both. Request confirmation
  does not approve a LogicModel. Compilation requires current successful checks
  and matching clinical approval.
- Compile results bind to the active `compilationId`, approved LogicModel, and
  `artifactHash`. Verification binds to that artifact, the active `verificationId`,
  and a `reportHash`. Only explicit boolean `passed: true` permits release review.
- Release approval binds to the complete passing verification evidence. Download
  readiness rechecks release, clinical, and artifact bindings. No live deployment
  is modeled or authorized.
- The PO, designer, drafter, checker, compiler, and verifier contributors are
  tracked by actor ID across revisions. Contributors cannot clinically approve
  their own work. The compiler cannot be the clinical approver; the verifier
  cannot be the compiler or clinical approver. The release approver must be
  independent of contributors and the clinical approver, even with multiple roles.
- A new request revision invalidates screening, PO confirmation, routing, model,
  checks, approvals, and artifact evidence. A new LogicModel revision preserves
  request confirmation but clears checks, clinical approval, and all later evidence.
  Changed content requires the next revision number and a different valid hash.
  Late callbacks retain old identities and cannot advance the revised workflow.

### Audit, duplicates and concurrency

Accepted transitions propose audit events with actor, command type, reason/note,
before/after states, workflow version, attempted/current request identity, current
model identity, and artifact hash. Rejected attempts also propose an audit record
and return the unchanged state. No audit is written, and no timestamp is generated;
the eventual backend must supply authoritative time and append-only persistence.

Accepted event IDs are recorded with deterministic canonical JSON fingerprints.
An identical repeated event returns `DUPLICATE` without another advancement,
even after later revisions. Reusing an event ID for different content is rejected.
This fingerprint is an event receipt, not a generated snapshot/content hash.
Rejected IDs are not recorded as accepted receipts; rejected attempts can be retried
and must be audited by the backend. Receipts are kept in state for this local MVP;
durable storage should manage them atomically with workflow updates.

`expectedVersion` rejects stale commands, but this pure function cannot serialize
concurrent callers. A future conditional write/transaction must atomically save
the new state, event receipt, and audit. Never launch work from a speculative
transition before the state update succeeds.

### Trust boundary and remaining integrations

Mock test identities are not authentication. The backend must resolve actor IDs,
roles, resource access, contributor provenance, and module callbacks itself.
It must load authoritative state/evidence and verify stored content against the
agreed hashes. Hash matching here cannot prove that clinical content was correct,
that a test really ran, or that bytes match the claimed hash. R4 schema validation
and R6 real compiled-behavior evidence remain essential.

- R1: display these states; submit bound PO decisions and corrections; display only
  backend-authorized downloadable artifacts.
- R3: supply the screened final preview and structured LogicModel proposals with
  their identities; preserve unresolved findings.
- R4: confirm shared contracts, canonical hash coverage/serialization, model
  revisions, and successful deterministic checker evidence.
- R5: return immutable compiled artifact identity for the approved model and run.
- R6: return independent synthetic verification with artifact, model, run, and
  report identities plus an explicit pass/fail result.
- R7: later supply identity infrastructure and transactional state/audit storage;
  coordinate real service identities, permissions, and delivery/retry mechanics.

Next: agree canonical snapshot contracts with R4 and implement small pure snapshot
helpers with fixtures. Then add a storage interface with conditional state updates
and a local fake, before exposing clinician/release approval APIs that resolve
actors and evidence on the server. Same-input job retry policy, production retention,
actual download access and link invalidation remain later integration work.

## Provisional snapshot hashing

`src/snapshots.ts` provides `createSnapshot(draft, validator)`, `canonicalizeJson`,
and separate `requestPreviewIdentity` / `logicModelIdentity` projections. It uses
pinned `canonicalize@3.0.0` (Apache-2.0), an implementation listed by RFC 8785,
and Node's built-in SHA-256. There is no handwritten key/number canonicalizer.

A snapshot is a copied, recursively frozen JSON object:

```json
{
  "kind": "LOGIC_MODEL",
  "requestId": "fictional-001",
  "revision": 1,
  "schemaVersion": "1.0",
  "hashPolicyVersion": "jcs-sha256-v1",
  "requestPreview": {
    "requestId": "fictional-001",
    "revision": 2,
    "snapshotHash": "<64 lowercase hex digits from the preview snapshot>"
  },
  "content": { "schemaVersion": "1.0", "...": "entire LogicModel" },
  "snapshotHash": "<computed SHA-256, not a caller-provided value>"
}
```

The angle-bracket values are explanatory placeholders, not executable fixtures.
A `REQUEST_PREVIEW` snapshot has the same base metadata but no `requestPreview`
reference. `revision` is the revision of that snapshot kind: a model revision is
not the same counter as the request preview revision. The model must reference a
preview for the same request. This code validates the reference's structure; the
future backend must establish that the referenced preview exists and is current.

Hash policy `jcs-sha256-v1` hashes UTF-8 RFC 8785 canonical JSON of the **entire
snapshot envelope except its own `snapshotHash` field**. It includes kind, request
ID, revision, schema version, hash-policy identifier, full content, and the model's
preview reference. Metadata changes therefore change the hash even when clinical
content stays the same. Object key ordering does not change it. Array order is
preserved, including question order and first-match decision-table rows.

All supplied JSON content is included: sources, citations, source hashes/URLs,
condition trees, outcomes, ambiguities, and optional visualization/extension data.
No content fields are selected away. A computed hash is an integrity fingerprint,
not proof of validation correctness, clinician approval, or release authorization.
Artifact identity remains separate; no compiled-artifact hashing is implemented.
The workflow and router are unchanged and continue to use their existing identity
contracts through the projections. Store the complete snapshot, not just its hash
or the reduced workflow fields.

The strict JSON-domain layer rejects undefined, functions, symbols, bigint,
non-finite numbers, lone Unicode surrogates in keys/values, sparse/decorated arrays,
cycles, non-plain objects, hidden properties, accessors, and proxies. It does not
invoke `toJSON` or normalize strings. It copies and freezes input before validation,
so changing the caller's original content cannot silently change a hashed snapshot.
Validators must be synchronous, return no transformed content, and throw to reject.

RFC 8785 uses ECMAScript IEEE-754 number serialization: `-0` and `0` canonicalize
to the same number, and equivalent representable numeric values have the same
hash. Unicode normalization is not performed: composed and decomposed spellings
remain distinct. Numbers requiring exact precision beyond IEEE-754 should use an
R4-agreed representation, such as validated decimal strings. Hashing cannot recover
precision already lost before the function received a JavaScript number.

Input is already-parsed JSON data, not JSON source text. A JavaScript object cannot
represent duplicate keys; a future raw JSON ingestion boundary must reject duplicate
keys and numeric tokens that violate R4's precision policy **before** normal parsing
would discard information. This milestone does not implement that parser.

`SnapshotError` reports `INVALID_JSON`, `INVALID_METADATA`, or `SCHEMA_REJECTED`.
Unknown metadata, caller-provided hashes/policy identifiers, and a missing validator
are rejected. Unknown JSON content extensions are retained and hashed by the
provisional adapter; their admissibility belongs to the final R4 schema.

### Pending Role 4 Integration

Reference reviewed: [R5 LogicModel v1 proposal on compiler branch](https://github.com/skootzs/MedicalMobile---AWS-Hackathon/blob/compiler/packages/compiler/docs/logic-model-v1-proposal.md),
Git blob `d6d5721f83053b9f3582090d33b2507cfa3cf3ff`. It explicitly identifies itself
as a draft, with R4 as schema owner. No compiler or schema files were changed.

`provisionalSnapshotValidator` checks only basic preview fields, or the proposal's
model version/title/pathway/language, required arrays, and one decision table.
It does **not** check reference integrity, AST constructs, question ordering,
completeness, ambiguity resolutions, clinical semantics, or compiler compatibility.
It must not be described as complete LogicModel validation. A caller must explicitly
supply this adapter or an R4 replacement to `createSnapshot`; there is no implicit
validation-success default. The full frozen content goes to the adapter, and schema
integration can change without rewriting the workflow state machine.

R4/team agreement is still needed on:

- Official versioned schemas for previews, models, sources/citations, and ambiguities,
  including required/unknown fields and runtime validation behavior.
- Exact hash envelope and coverage, especially metadata and the originating preview.
  A change in hash rules requires a new hash-policy identifier and compatibility plan.
- JCS/UTF-8/SHA-256 agreement, numeric precision/ranges, Unicode policy, and strict
  raw JSON parsing responsibilities.
- Model versus preview revision numbering and rules for schema upgrades and migrations.
- Cross-module golden snapshots with expected canonical bytes and hashes, plus R4
  checks proving the model supplied to reviewers is what the compiler consumes.

### Local dependency installation for this milestone

The snapshot dependency and existing pinned dev tools are installed only in this
package's ignored `node_modules`. The install explicitly used `--workspaces=false`,
`--package-lock=false`, and `--ignore-scripts`; no root/shared configuration or
repository lockfile was changed. `npm run typecheck` and `npm test` now work directly
from this package. The earlier temporary typecheck tool directory is not required.
This local installation does not decide the team's package manager or lockfile
ownership. Normal workspace installation and reproducible locked CI remain pending.
Do not run a default root install against the empty root manifest.

Next: finalize R4's contract, then define a snapshot repository with immutable writes,
hash verification on load, and atomic workflow/event/audit updates. Test it with a
local fake before adding authenticated approval APIs. No database, API, AWS adapter,
Strands Box, or real review job has been added here.

## Provisional storage and audit contracts (R2)

`src/storage/requests.ts` defines the replaceable async `OrchestratorStore`:

- `apply(command, principal)` is the only write operation. A command includes the
  request ID, a server-assigned `attemptId`, an actor-free workflow event, and any
  new immutable snapshots needed by that transition.
- `getWorkflow` loads the current state/version. Versioned request content is kept
  in immutable preview snapshots; this fake does not store a separate historical
  workflow state for every version.
- `getSnapshot` and `listSnapshots` retrieve verified immutable snapshot history.
- `getReceipt`, `listEvidence`, and `listAudit` expose copied historical records.

There is no public `setState`, `putApproval`, snapshot-overwrite, or audit-update
method. `artifacts.ts` defines accepted evidence history for screening, PO
confirmation, R4 checks, clinical decisions, compiled artifact references,
verification evidence, and release decisions. A reviewer rejection/return is an
accepted decision event but does not become an approval. Only artifact/report references are stored. The adapter adds no patient/profile,
credential, name, or email fields and does not retain principal context.
Pseudonymous actor IDs and required decision notes remain in records. Only public
or fictional workflow data belongs here; no automatic PHI detector is implemented.

### How it interacts with the workflow

```text
Internal backend command + principal context
  -> resolve actor through injected trusted-backend boundary
  -> read the latest stored workflow version
  -> transitionWorkflow(currentState, eventWithResolvedActor)
  -> verify required preview / LogicModel snapshots and immutable evidence IDs
  -> atomically publish state + snapshots + evidence + receipt + audit
  -> return ACCEPTED / REJECTED / DUPLICATE (or throw on storage failure)
```

The adapter calls the existing pure transition function rather than accepting a
caller-supplied next state. All existing routing, role separation, revision, clinical
approval, verification, and release guards remain there. `NOT_READY` cannot advance
state or create SD work. No review jobs, compilation, URLs, or other external actions
are triggered by a committed route or transition.

The event's `expectedVersion` is the conditional-update guard; submission expects
version 0, each accepted transition increments it once, and rejected/duplicate
attempts leave it unchanged. After awaiting actor resolution, the fake reads the
latest version and performs all remaining work synchronously without another await.
It builds replacement Maps and publishes them with one pointer assignment. Two
concurrent continuations therefore cannot both consume the same version in this
single JavaScript process. That is **not** a distributed database transaction.

### Snapshot and evidence integrity

The adapter reconstructs snapshots through `createSnapshot` and the injected schema
validator, compares hashes and policy versions, and verifies the requested storage
slot on write and load. Stored bytes are immutable canonical JSON strings; loads
also reject byte changes that JSON parsing alone could discard, such as duplicate keys. A preview must contain
exactly the workflow brief's content (excluding its identity fields), and its hash
must match the brief. A current model needs an existing matching LogicModel
snapshot linked to that exact preview. There is no acceptance of invented model
hashes simply because they have 64 hexadecimal digits.

Preview slots are `(requestId, REQUEST_PREVIEW, revision)`. LogicModel slots also
include the originating preview identity because the existing workflow restarts
LogicModel revision numbering at 1 after a request revision. R4 must confirm this
scope before shared integration. A different snapshot cannot replace an occupied
slot; supplying identical bytes is harmless. Bundled snapshots must belong to the
same request and the resulting current preview/model, so a transition cannot insert
unrelated or orphan snapshot history.

Workflow and receipt reads reverify their referenced preview. Workflow reads also
check the current LogicModel; historical evidence reads verify referenced preview
and model snapshots. Artifact and verification records contain version-bound IDs and
hash references only. This milestone cannot prove actual artifact/report bytes or
real test execution: those remain R5/R6/backend responsibilities. Audit reads return
historical diagnostics, including rejected attempts whose claimed references may
intentionally be missing or invalid.

Current state is returned as a deep copy. Loaded snapshots are rebuilt and frozen.
Evidence, receipts and audits are copied on return, so mutating a returned object
cannot change stored records. Old evidence and approvals remain in history after
revisions, while the current state's applicable approvals are invalidated by the
workflow. Reusing an immutable evidence ID for another event is rejected.

### Idempotency, audit and rollback

`eventId` identifies a workflow command; `attemptId` identifies an application
attempt/audit entry. Both are scoped to the request:

- An accepted event stores one receipt containing the workflow fingerprint,
  resulting version, request identity, and original audit ID.
- Repeating the same attempt with identical content and resolved actor returns the
  original result with `replayed: true`, without another write. Its original
  ACCEPTED response does not mean a second transition occurred.
- The same event under a fresh attempt returns `DUPLICATE` and appends a duplicate
  audit entry without another state advancement, snapshot, evidence record or receipt.
  Snapshot attachments on non-accepted events are not written.
- Changing event content under an accepted event ID is rejected and audited.
  Changing content under an existing attempt ID throws `ATTEMPT_ID_REUSED`; its
  existing audit is never overwritten. A new attempt ID is required for new work.
- Workflow rejections, unauthorized attempts, and snapshot/evidence conflicts append
  only a rejection audit when a valid request/attempt scope and functioning storage
  are available. They do not change workflow state, evidence, receipts or snapshots.

`audit.ts` defines append-only records extending the workflow's proposed audit with
an audit ID, per-request sequence and backend timestamp. A backend clock is used,
not a browser timestamp. No update/delete audit operation is exposed. The fake keeps
attempt fingerprints privately for replay detection; these are not snapshot hashes.

All writes are staged before commit. If the clock or final commit fails, none of
that transaction's state, evidence, snapshots, receipt or audit is saved. Snapshot
schema/hash failures also cannot leave partly saved content. A rejection audit can
be the deliberate sole result of a blocked operation; that is not a partially saved
accepted transition. Some failures cannot be audited here: missing request/attempt
IDs, uncloneable commands, attempt-ID collisions, corrupted stored snapshots, or a
failed audit/commit operation. A future backend needs a separate operational failure
log for these cases and must never report success when its transaction failed.

### Trust boundary and fake limitations

`InMemoryOrchestratorStore` requires `resolveActor(principal, requestId)` and
`validateSnapshot`. There is no default trusted actor. The event cannot carry an
`actor`; the adapter injects the resolved backend identity and then applies workflow
role/independence guards. It rejects caller-supplied next-state or approval fields
on the command envelope. Principal context is not retained. An unresolved identity
gets a rejection result without a workflow version disclosure.

The resolver is a **dependency boundary, not implemented authentication**. Tests
map fictional strings to mock actors. Never expose that mapping as HTTP auth.
Production must authenticate sessions/service callers, enforce request-level access,
validate callback provenance and R4 schemas, and resolve real authorized roles.
Reads are internal repository methods and must also sit behind backend authorization.
An authorized module's callback still needs server verification that its referenced
checks/artifacts/reports really exist and are authoritative. A database adapter alone
cannot establish clinical truth or trustworthy provenance.

The fake is process-local, volatile, unbounded, and intended for fictional tests.
Restarting loses all data; separate instances do not coordinate. It has no durable
persistence, distributed locks/transactions, encryption configuration, pagination,
production retention, or real access controls. Optional `testFaults` hooks simulate
commit failures/corrupt read bytes solely for tests; they are not part of the
`OrchestratorStore` interface and must not be exposed in production.

### Pending Role 4 Integration — storage

Confirm shared event/evidence schemas, schema-version dispatch for historical
snapshots, preview/model revision scope, immutable evidence ID uniqueness, and
hash coverage before adopting these contracts outside this package. The current
snapshot adapter remains shape-only. Existing router/workflow/snapshot modules and
all their original tests are preserved.

Next: review this milestone, then add an application command service for clinician
and release decisions that loads the exact snapshots/evidence, resolves authenticated
actors, and calls `apply` with expected versions. Test that service locally before
adding Fastify handlers. Coordinate a durable adapter with R7 that preserves atomic
conditional updates across state, receipts, evidence and append-only audit; never
run downstream work until the transaction succeeds. No cloud, API, Cognito,
DynamoDB, S3, Strands Box, deployment or database implementation is added here.

## Application service and version-bound human decisions

`src/approvals.ts` exports `ApprovalService.execute(command, principal)` and a
provisional `ApprovalCommand`. This is an internal application service, not an HTTP
endpoint. It coordinates stored evidence and existing workflow guards; it does not
implement authentication, generate clinical logic, or perform clinical validation.

Both clinical/content and release commands contain `requestId`, `eventId`,
`expectedVersion`, the exact request preview revision/hash, the LogicModel
revision/hash, a decision (`APPROVE`, `REJECT`, or `RETURN`), and an optional note.
Rejections/returns require a non-empty note. Clinical commands name the R4 checker
report ID. Release commands additionally name the clinical approval event,
compilation ID, artifact hash, verification ID and verification-report hash.
R1 should obtain these references from an authorized backend review view, rather
than asking a reviewer to type hashes manually.

The command schema rejects unknown fields, including actor IDs, roles, `trusted`,
`passed`, or server-only guard properties. Hashes and revisions are references to
check, not proof that a review/test passed. The service loads snapshots and accepted
evidence through `OrchestratorStore`; it never accepts a verification document or
passing flag supplied in the reviewer command as authoritative.

```text
Typed reviewer command + opaque backend principal context
  -> injected request-scoped identity provider
  -> load current workflow, verified snapshots and immutable evidence
  -> match request/model/checker/clinical/artifact/verification references
  -> preflight with the existing transitionWorkflow function
  -> store.apply with expected version and resolved-actor binding
  -> store re-resolves identity and runs current workflow guards
  -> atomically save state, receipt, decision record and audit
```

Role permissions, contributor independence, permitted states, and approval gates
remain in `workflow.ts`. The service reuses that function for preflight and the
store invokes it again over the latest state. The additional service checks bind
references to actual accepted ledger records. A successful R4 report must be an
unambiguous stored `LOGIC_CHECKED` event with literal boolean `passed: true` and
the exact request and model identity. A string such as `"true"` is not success.
A computed snapshot hash, PO confirmation or preliminary screening cannot satisfy
this check or substitute for clinical approval.

For release, the service also checks the current clinical approval and its accepted
reviewer decision, compiler evidence, and current passing R6 verification record.
The workflow then enforces a separate authorized release approver and blocks
contributors or the clinician from granting release approval. A clinical decision
cannot approve a stale LogicModel, and a release decision cannot approve another
artifact or report. New model/request revisions continue to invalidate approvals
through the unchanged workflow implementation.

### Small storage contract additions

Three optional internal `ApplyCommand` fields support this boundary:

- `expectedActorId` binds commit to the actor resolved during service preflight.
  A different identity at commit is rejected. The store still resolves current
  roles itself, so losing the clinician role before commit also blocks approval.
- `preconditionFailure` records a service validation failure as a rejection audit
  without advancing state. It can only reject; it never grants permission.
- `commandFingerprint` is SHA-256 of canonical JSON for the complete validated
  application command, including evidence references that are not workflow-event
  fields. It is stored on the accepted event receipt and detects event-ID reuse
  with altered checker/clinical/verification references. This is not a snapshot or
  artifact hash, and it does not establish approval authority.

These fields are generated by backend service code and are not allowed in the
reviewer command. A real storage adapter must enforce the same semantics. Existing
commands/receipts without an application fingerprint retain their existing behavior;
a new application command cannot claim such a receipt as its own accepted event.

The service uses a backend-generated attempt ID (`randomUUID` by default) for each
call; tests can inject deterministic unique IDs. Exact accepted retries load the
original immutable decision event and return a duplicate even after later content
revisions. They do not restore old approvals or advance the new revision. Changing
a command under the same accepted event ID is rejected. Same-attempt storage replay
also creates no extra audit/decision. New attempts at the same event can append a
DUPLICATE audit without duplicating the approval record.

### Structured results and failures

Results contain request/event IDs, a reason code, workflow version, audit ID when
recorded, and a replay marker, with one of:

| Status | Meaning |
| --- | --- |
| `SUCCESS` | The human decision was recorded. This includes explicit REJECT/RETURN, not just approval. Inspect the decision and resulting state. |
| `REJECTED` | Invalid command, unauthorized/independent-review failure, missing or incompatible evidence, or event-ID reuse. |
| `STALE_VERSION` | Workflow version, request snapshot, LogicModel or artifact reference is outdated; reload the review view. |
| `DUPLICATE_EVENT` | An already accepted identical decision was recognized, without another transition or approval record. |
| `STORAGE_FAILURE` | Reading, integrity verification, audit/commit, or another storage operation failed; do not report approval success. |

Well-formed rejected decisions are submitted through storage as rejected attempts,
so they append audit records without changing authorized state or evidence. Invalid
command shapes return rejection before storage and have no audit ID. Read failures
or broken receipt history may likewise prevent recording an audit. The eventual
HTTP/backend layer needs operational logging for those cases. Failure results do
not claim that audit recording succeeded.

Optimistic concurrency is the final protection against changes between asynchronous
service reads and commit. The fake's atomic update publishes all records together,
and injected failures leave no partial approval/audit/receipt. The application
service itself does not supply distributed transactions or durability.

### Authentication, schema and integration limits

The service and store must use the same trusted, request-scoped identity source.
The provider must authenticate session/service context and authorize access to the
request before returning only the required actor ID/roles. Fictional string-to-actor
mappings exist only in test fixtures and must never become browser authentication.
The store re-resolves at commit; a provider failure or mismatched identity cannot
fall back to granting approval. Real authentication remains pending; the local HTTP milestone below adds an
injected request-access boundary, with access denied by default.

Stored R4/R5/R6 events are authoritative only within the backend trust boundary.
Real integration must authenticate callbacks and verify the actual reports and
artifact bytes. The current R4 validation adapter remains provisional/shape-only;
checker compatibility here means exact accepted report/model bindings, not proof of
clinical correctness or a complete R4 evaluator implementation.

All new application contracts remain local until R4 confirms shared schemas for
commands, checker/verification evidence, schema versions, and audit/idempotency
metadata. The in-memory store remains process-local and volatile. This application-service milestone added no database, Cognito, Bedrock, AWS
or Strands Box integration. The following milestone supplies the local HTTP adapter.

Next: add a thin Fastify adapter around this service with explicit request/response
schemas and injected authentication. Derive principal context from server-verified
sessions, pass only permitted reviewer fields, and map service outcomes to clear
HTTP responses. Test routes with `inject()` using fictional providers first; never
accept actor/role/trusted flags from the body or public headers as authentication.
Coordinate a durable adapter and request-scoped identity integration with R7 before
exposing the service publicly.


## Local Fastify API (provisional, test-only)

`createLocalApi()` in `src/server.ts` wraps the existing ApprovalService and store.
It exposes only `inject()` and `close()`: no public listener, `listen()` method,
raw server, or start script is provided. All business guards still belong to the
existing service/workflow/store; the HTTP layer validates and translates messages.

| Route | Purpose |
| --- | --- |
| `GET /api/requests/:requestId/status` | Read an accessible request's status and current version only. |
| `POST /api/requests/:requestId/clinical-decisions` | Record APPROVE, REJECT, or RETURN for exact checked clinical/content LogicModel evidence. |
| `POST /api/requests/:requestId/release-decisions` | Record APPROVE, REJECT, or RETURN for exact compiled/verified artifact evidence. |

The POST body is the existing application command without `type` or `requestId`:
the server derives those from the route. Common fields are `eventId`,
`expectedVersion`, `requestRevision`, `requestSnapshotHash`, `logicRevision`,
`logicHash`, `decision`, and optional `note`. REJECT/RETURN require a nonblank note.
Clinical decisions also require `checkerReportId`. Release decisions instead require
`clinicalApprovalEventId`, `compilationId`, `artifactHash`, `verificationId`, and
`verificationReportHash`. These are references, never authoritative evidence supplied
by the client: ApprovalService loads and checks backend records.

### Authentication and validation

`AuthenticationBoundary` is injected server code with `authenticate()` and
`canAccessRequest()`. Omitted authentication denies every request. Authentication
establishes an opaque principal before body parsing; request access is checked before
handler storage/service calls. The service/store must resolve that context through
the same trusted identity source. Role and independence checks remain in the service
and workflow. The only mock session mapping is under `test/helpers/api-fixtures.ts`;
no source file imports it. It has no production security value.

Actor IDs, roles, trusted flags, evidence-authority fields, body request IDs and
command types are rejected as unexpected body properties. Spoofed actor/role headers
do not authenticate anyone. Input validation does not coerce values, remove unknown
fields or insert defaults. Provisional transport limits: 32 KiB body, identifiers
1–100 characters without leading/trailing whitespace, positive safe revision
integers, nonnegative safe expected versions, lowercase 64-character SHA-256 strings,
and notes up to 2,000 characters. Unknown query parameters are rejected. Responses
use explicit schemas, generic infrastructure errors, and `Cache-Control: no-store`.

### Response semantics

| HTTP | Meaning |
| --- | --- |
| 200 | Decision recorded, or identical previously accepted event recognized; GET returns status/version. |
| 400 | Malformed JSON, invalid/missing field or unexpected property. |
| 401 | No verified principal. |
| 403 | Authenticated actor fails decision role or reviewer-independence rules. |
| 404 | Request absent or inaccessible; same generic response for both. |
| 409 | Stale version, conflicting event or incompatible/missing approval evidence. |
| 503 | Authentication/access provider or storage/infrastructure failure; no internal exception details. |

A successful POST returns `reviewType`, `decision`, `decisionRecorded: true`,
`outcome: DECISION_RECORDED`, `duplicate: false`, `workflowVersion`, `auditId`, and
request/event IDs. A recorded REJECT or RETURN is a successful decision submission,
not approval. There is no `approvalGranted` flag or download permission in this
response. Clinical approval alone never authorizes release.

An exact retry returns 200 with `outcome: DUPLICATE_EVENT` and `duplicate: true`.
It does not repeat a transition or decision record; a distinct attempt may append
a DUPLICATE audit entry under the existing service semantics. Reusing an accepted
event ID with a changed command returns 409. A retry after later revisions acknowledges
the original event and never reactivates old approval. Read current status separately.
Malformed/unauthenticated/resource-denied HTTP attempts are blocked before the service
and do not receive durable audit entries; operational security logging is still pending.

### Fictional examples

An authorized injected GET `/api/requests/fictional-001/status` returns 200:

```json
{"requestId":"fictional-001","status":"WAITING_FOR_CLINICAL_APPROVAL","version":7}
```

A clinical POST to `/api/requests/fictional-001/clinical-decisions` in the existing
fictional test fixture uses hashes computed from its immutable snapshots:

```json
{
  "eventId": "http-clinical-7",
  "expectedVersion": 7,
  "requestRevision": 1,
  "requestSnapshotHash": "0de6a9d3c1fb64bc258d9252c371c2faa5639f39858ef32b155346727402b952",
  "logicRevision": 1,
  "logicHash": "b8da115e6b0ab7e04e56dcb9d4d1167e2b34a481c7c5a0dcbdbd87f22aa103f1",
  "checkerReportId": "checks-6",
  "decision": "APPROVE"
}
```

With the fictional clinician context and deterministic test attempt ID, it returns:

```json
{
  "requestId": "fictional-001",
  "eventId": "http-clinical-7",
  "reviewType": "CLINICAL_CONTENT",
  "decision": "APPROVE",
  "outcome": "DECISION_RECORDED",
  "decisionRecorded": true,
  "duplicate": false,
  "workflowVersion": 8,
  "auditId": "[\"fictional-001\",\"example-http-attempt\"]"
}
```

Use `api.inject({ method, url, headers, payload })` with the test-only provider;
there is no listening URL. Tests seed the store directly. They cover clinical and
release approval, explicit REJECT/RETURN, independent reviewers, stale/concurrent
commands, duplicates, schema validation, access isolation and rollback on failure.
Run `npm run typecheck` and `npm test` from this package. There are 56 HTTP tests
plus the original 303 tests (359 total).

### Dependencies and Pending Role 4 Integration

Fastify is pinned to 5.12.8 in this package. Fastify v5 supports Node.js 20+, which
includes the intended Node.js 22 runtime. See the official
[migration guide](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/),
[validation reference](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
and [injection testing guide](https://fastify.dev/docs/latest/Guides/Testing/).
Verification here used Node.js 24.18.0 and Node 22 typings; running the suite on an
actual Node.js 22 runtime remains an integration check.

Installation stayed package-local with `--workspaces=false --package-lock=false
--ignore-scripts`; no root configuration, shared lockfile, other package or existing
strict tsconfig was changed. Shared package manager/lockfile ownership still needs
team agreement before workspace integration; a clean install currently resolves
transitive dependencies without a committed lockfile.

R4 must confirm final command/evidence schemas, identifier/hash formats, transport
limits and error/state vocabulary. The provisional schema-validation boundary still
does not establish full clinical correctness. No request creation, PO confirmation,
screening callback, review-job dispatch, artifact download, real authentication or
durable database is implemented. Mock providers and the volatile store remain local
fixtures. Real provider/callback verification, request membership policy and atomic
durable storage are required before exposing a server.

Smallest next step: agree a read-only authorized review-context response with R1
and R4 (snapshot, checker and verification references needed to build these commands),
then test one UI review journey through `inject()`. Follow with request creation/PO
confirmation and trusted authentication/durable adapters with the responsible teammates.

## Request creation, revisions and PO confirmation (local milestone)

`src/requests.ts` adds RequestService around existing SUBMIT,
SCREENING_COMPLETED, PO_DECISION and REVISE_REQUEST events. It does not replace
routing, workflow, snapshot validation or store guards. `createLocalApi()` accepts
an optional `requests` service; without it, existing approval-only integrations
retain their old routes. There are still only `inject()` and `close()` methods,
no listening server or real authentication.

The lifecycle is:

```mermaid
stateDiagram-v2
  [*] --> WAITING_FOR_SCREENING: authenticated PO submits
  WAITING_FOR_SCREENING --> WAITING_FOR_SCREENING: material interpretation/correction creates new preview
  WAITING_FOR_SCREENING --> WAITING_FOR_PO_CONFIRMATION: trusted R3 completed screening
  WAITING_FOR_PO_CONFIRMATION --> READY_TO_ROUTE: owner PO confirms exact preview and screening
  WAITING_FOR_PO_CONFIRMATION --> RETURNED_FOR_CLARIFICATION: owner PO requests revision
  RETURNED_FOR_CLARIFICATION --> WAITING_FOR_SCREENING: material correction creates new preview
```

An eligible confirmation ends at READY_TO_ROUTE. No routing result, review task,
model call, downstream job or approval is created. Existing guarded routing remains
an explicit later backend action. PO confirmation records agreement that the current
AI interpretation represents the requested change, not clinical approval. Clinical
and independent release approval remain mandatory later.

### HTTP contracts for R1

| Route | Input / result |
| --- | --- |
| `POST /api/requests` | `{eventId, expectedVersion: 0, content}`. Returns 201 for new request, 200 for exact retry. |
| `GET /api/requests/:requestId` | Owner-only current status/version, immutable preview metadata/content, current screening, confirmation and `clinicalApprovalRequired: true`. |
| `POST /api/requests/:requestId/confirmations` | `{eventId, expectedVersion, revision, snapshotHash, screeningId, decision}`. Decision is CONFIRMED or REVISION_REQUESTED. |
| `POST /api/requests/:requestId/revisions` | `{eventId, expectedVersion, revision, snapshotHash, content}`. Identity/version reference the old current preview; server creates revision + 1. |

A separate revision endpoint is needed because requesting a correction records a
PO decision, while supplying corrected content creates a distinct immutable revision.
Revision commands supply full replacement content, not a partial patch. Unchanged
content (including reordered object keys) is rejected with NO_MATERIAL_CHANGE;
changing revision metadata alone must not manufacture a content change. Historical
snapshots, screenings, decisions and audit entries are retained. The current state
clears superseded screening, confirmation, routing, logic and downstream approval/
build evidence through the existing workflow's revision event.

All new write commands reject unknown fields. The provisional content contract is
`title`, `objective`, `targetPopulation`, and a nonempty `requirements` array of
`{condition, action}`. HTTP text fields are limited to 5,000 characters, requirements
to 100 items, with the existing 32 KiB total body limit. This is minimum structured
intake, not an assessment of completeness/ambiguity/clinical safety; R3 still owns
those assessments. Free-text-only/incomplete drafts need an agreed R1/R3/R4 contract
before adding another intake shape. Stored preview responses preserve every hashed
content field, including schema extensions; response serialization must not silently
trim fields covered by the snapshot hash.

Each successful write returns status SUCCESS or DUPLICATE_EVENT, reason, requestId,
eventId, workflowVersion, accepted request revision/hash, and auditId. The current
version on a duplicate can be newer than the original accepted revision; fetch the
current request before editing again. A duplicate never restores stale evidence.
Read current status to distinguish CONFIRMED from a recorded correction request.
HTTP errors follow the previous API conventions: 400 malformed input, 401 missing
principal, 403 wrong action role, generic 404 missing/inaccessible/not-owned resource,
409 wrong state/stale revision/version/conflicting event, and sanitized 503 storage
or provider failure. Rejected valid attempts are audited when storage permits;
malformed/unauthenticated/access-denied HTTP attempts never reach the store.

### Server identity and creation idempotency

The authentication boundary still defaults to deny. The creation route alone has
no existing request membership to check; it still requires authentication, and
RequestService checks the server-resolved PO role. Other routes require existing
request access; RequestService additionally enforces PO ownership for intake reads,
confirmations and public corrections. The store re-resolves the actor and enforces
workflow authorization at atomic commit, including optimistic version protection.
Reviewer access belongs to a future separate review-context API.

The backend assigns `req-` plus SHA-256 of canonical JSON containing the fixed
`r2-request-id-v1` namespace, verified owner ID and submission eventId. This is a
provisional deterministic request-ID policy, separate from snapshot hashing. It
provides a stable unique namespace per owner/submission key without a process-local
reservation map or an additional non-atomic storage write. Browser callers cannot
choose requestId or ownerId. These IDs are predictable identifiers, never secrets
or access tokens. Ownership checks remain required. A future random-ID policy would
need a durable unique `(ownerId, submissionEventId)` index committed with creation;
changing this policy requires an integration/migration decision.

R1 should generate a new eventId for each user intent and retain it for retries.
Retrying identical creation returns the same request ID, even through a new service
instance sharing storage. Changed content under the same key returns 409. Two
verified POs using the same eventId get separate requests. Accepted event receipts
and command fingerprints detect conflicting retries. All state, snapshots,
receipts and audit updates use existing store.apply(), with no side map. A failed
commit leaves no partial write. A failure reading the receipt after a successful
commit can return 503 even though the write exists; retry the identical command to
resolve it safely. In-memory receipts last only as long as that store instance.

### Internal integration for R3

There is NO HTTP screening callback or interpretation endpoint. RequestService
exposes these internal methods for a future authenticated backend adapter:

- `reviseInterpretation({...currentIdentity, eventId, expectedVersion, content}, principal)`
  creates a changed preview through REVISE_REQUEST. Existing workflow rules allow
  DRAFTER changes only while waiting for screening or after return for clarification.
  If the preview is already awaiting PO confirmation, a correction must first be
  requested; R3 cannot silently replace it.
- `recordScreening({...currentIdentity, eventId, expectedVersion, screening}, principal)`
  requires a server-resolved DRAFTER. Screening must bind to exactly requestId,
  revision and snapshotHash, with screeningId, status and the five structured checks:
  completeness, ambiguities, contradictions, clinicalSafety and feasibility.

Pending, failed, malformed or stale screening cannot advance eligibility. The
existing workflow/router validate completed screening; unresolved concerns may reach
PO interpretation confirmation and then require Service Designer review through an
explicit routing event. They are not clinical approval. After a material change,
R3 must screen the new preview, and PO must confirm that same screened preview.
R3 event/screening IDs must be unique within the request; exact accepted retries are
idempotent. A retry of an older accepted screening acknowledges the old event without
restoring superseded state.

`test/helpers/request-fixtures.ts` isolates fictional token mappings and a mock
internal R3 adapter. No src file imports those fixtures. Real R3 service identity,
request/tenant authorization and callback integrity remain unimplemented. No
browser-supplied trusted flag, role, actor ID, screening completion or approval is
used as authority.

### Fictional API example

Through an injected fictional PO session, create a request:

```http
POST /api/requests
Content-Type: application/json
```

```json
{
  "eventId": "fictional-create-1",
  "expectedVersion": 0,
  "content": {
    "title": "Fictional training checklist 1",
    "objective": "Record a training visit.",
    "targetPopulation": "Fictional training households",
    "requirements": [{"condition":"Checklist completed","action":"Show completion message"}]
  }
}
```

The fictional owner fixture produces requestId
`req-169ca093953000d6fa78f9e50492d1fbe76731831cb9f962f44fc946f8031e8b`.
The 201 response includes `workflowVersion: 1` and the computed request identity:

```json
{
  "requestId": "req-169ca093953000d6fa78f9e50492d1fbe76731831cb9f962f44fc946f8031e8b",
  "revision": 1,
  "snapshotHash": "fba85d3a816b864747b6779e15b2fd6870a2caadf23fb757f59d0ea8d2eb20b6"
}
```

GET `/api/requests/<returned-requestId>` returns status WAITING_FOR_SCREENING,
version 1, preview metadata/content, null screening/confirmation and
`clinicalApprovalRequired: true`. After the internal fictional R3 adapter records
screening `screen-1`, GET returns WAITING_FOR_PO_CONFIRMATION at version 2.
POST `/api/requests/<returned-requestId>/confirmations`:

```json
{
  "eventId": "confirm-event",
  "expectedVersion": 2,
  "revision": 1,
  "snapshotHash": "fba85d3a816b864747b6779e15b2fd6870a2caadf23fb757f59d0ea8d2eb20b6",
  "screeningId": "screen-1",
  "decision": "CONFIRMED"
}
```

The 200 response records PO_DECISION with workflowVersion 3. A subsequent GET
shows READY_TO_ROUTE; clinical/release approval has not been granted. For correction,
use REVISION_REQUESTED instead, then submit new content to `/revisions` with the
returned current version and old preview identity. The next revision waits for
screening again. All hashes above were computed from fictional snapshots; clients
must read actual current identities rather than copying fixture values.

### Pending Role 4 Integration and next milestone

No dependency installation or root configuration changes were necessary. All original
359 tests are preserved. The added service/HTTP tests cover ownership, revisions,
rescreening, event retries, concurrent updates, immutable history, rollback and
mandatory approval gates. Run `npm run typecheck` and `npm test` in this package.
The test environment remains Node 24.18.0 with Node 22 typings; actual Node 22 runtime
verification remains pending.

R4 still needs to agree request/interpretation content shape, how incomplete drafts
are represented, schema version 1.0 replacement, hash-policy/schema migrations,
material-change policy (currently any canonical content change), event/screening ID
rules, state/error vocabulary and transport limits. Confirmation ID currently uses
its accepted eventId. Original submissions and interpreted previews share the request
preview revision sequence; the initial immutable revision remains in history when R3
revises it. LogicModel and compiled artifact identities remain separate.

With R1/R3/R4 agree owner versus delegated/tenant access, event-key lifecycle and the
workflow for returning AI interpretations. Durable database transactions, real
session/service authentication and operational security logging are still required
before exposing this local harness. No AWS, production listener, job dispatch,
compilation, download or database adapter is introduced.

Next milestone: owner/reviewer-specific read-only review-context APIs plus authorized
reviewer queues. First agree R1's display needs and R4's checker/verification bindings;
return exact snapshot/evidence references to authorized independent reviewers, then
connect the existing decision endpoints. Keep queue reads separate from job dispatch
and enforce request visibility without leaking inaccessible work.

## Authorized reviewer queues and review context (local milestone)

`ReviewService` in `src/reviews.ts` provides a read-only view of pending human
reviews. It never calls store.apply(), records a decision, creates an assignment,
appends an audit event, reserves a task or dispatches a job. Add it as the optional
`reviews` dependency of createLocalApi(); other local integrations retain their
existing routes. No listener, dependencies, root configuration or real auth adapter
was added.

| Category query | Verified role | Current pending state |
| --- | --- | --- |
| SERVICE_DESIGNER | SERVICE_DESIGNER | NEEDS_SD_REVIEW |
| CLINICAL | CLINICIAN | WAITING_FOR_CLINICAL_APPROVAL |
| RELEASE | RELEASE_APPROVER | WAITING_FOR_RELEASE_APPROVAL |

`GET /api/reviews/queue?category=CLINICAL` returns only accessible, currently
eligible items. Category is a view selector, never a client claim of authority.
NOT_READY and pre-routing requests never become SD tasks. Completed, rejected,
returned and revised reviews leave the active queue. Blocked pending reviews are
excluded from the active queue; an otherwise authorized reviewer can request their
context to inspect why eligibility is blocked.

`GET /api/requests/:requestId/review-context?category=CLINICAL&expectedVersion=7`
returns the exact current review snapshot and evidence references. expectedVersion
is optional; when supplied it is a positive integer encoded as a query string.
A version mismatch or nonpending review returns 409. Unauthenticated calls return
401; wrong-category roles return 403; inaccessible and nonexistent requests share a
generic 404; invalid query parameters return 400; infrastructure failures return a
sanitized 503. Extra query properties, including roles/actor IDs/trusted flags, are
rejected. Responses retain Cache-Control: no-store. There is no public server URL.

### Authorization, discovery and evidence

The required injected canAccessRequest policy checks trusted request visibility and
may apply assignment restrictions if the team later defines them. There is no
permissive default and no invented assignment data. Use the same trusted membership
policy as AuthenticationBoundary.canAccessRequest. Request-level actors resolve from
the same server identity source as the application service and store. The queue
first resolves the reviewer in the internal `review-queue` scope, then rechecks
visibility and role separately for every candidate. No raw candidate IDs or hidden
counts are returned. Identity/role and resource visibility are checked again during
context construction; queue items are checked again before the assembled list is
returned. The individual HTTP context route also passes the existing auth hooks.
All fictional session mappings remain under test/helpers/review-fixtures.ts only.

The separate ReviewCandidateSource read port in storage/requests.ts exposes only
listReviewCandidates(status). The in-memory implementation reads current states and
returns a detached, sorted ID list. A candidate is not authorized work: ReviewService
loads current state, verified snapshots and authoritative evidence only after access
checks. Stale or duplicate index entries cannot create duplicate or obsolete queue
items. A future database adapter can replace discovery without changing decision
logic or existing store write contracts.

Clinical/release contexts share the approval service's existing evidenceFailure()
and commandEvent() mappings. These two pure internal helpers are exported for reuse;
their behavior is unchanged. Eligibility also probes the existing pure workflow
transition with the verified actor and a noncolliding diagnostic event ID. The
proposed transition/audit are discarded. No approval guard is independently rewritten,
and no probe receipt or audit record is persisted.

A context contains category, requestId, workflowVersion, workflow status, current
request identity, eligibility with reason codes, unresolved preliminary-screening
findings, and clinicalApprovalRequired: true. Evidence is category-specific:

- SD: full current preview snapshot, relevant screening and routing clarification
  reasons. Stored screening/PO evidence and the exact current SD routing result must
  match. An SD context does not authorize clinical approval.
- Clinical: full current LogicModel snapshot and applicable checker reference/outcome.
  Missing, failed, stale or incompatible snapshots/checks block eligibility. The
  workflow's owner/contributor restrictions block self-approval.
- Release: current LogicModel snapshot, checker reference, clinical approval event/
  model reference, compiled artifact identity/hash, verification reference/hash/outcome.
  Clinical, compiled and verified records must match authoritative evidence. The
  original clinician or another contributor cannot act as independent release approver.

Unused category fields are null. Owner/contributor IDs, actor identities, roles,
workflow event history, credentials and raw audit records are not returned. Full
hashed snapshot content is preserved, including sources and ambiguity arrays.
Mismatched cross-request snapshots are not exposed. Checker and verification reports
currently provide references plus passed booleans, not full report findings; no
missing report details are fabricated. R4/R6 must define richer report contracts.

An accessible pending context returns 200 even when eligibility is false; reasons
explain the blocker and decisionReferences is null. A self-reviewer may inspect a
visible blocked context but cannot submit an approval or enter the eligible queue.
For an eligible clinical/release context, decisionReferences contains precisely the
existing decision POST fields, excluding eventId, decision, note and path requestId.
R1 can submit `{...decisionReferences, eventId, decision, note?}` to the existing
clinical-decisions or release-decisions route. Neither eligibility nor queue
membership is an approval or a server-issued authorization token. ApprovalService
reloads authoritative evidence and the store rechecks roles, independence, version
and workflow guards on submission. Identical accepted retries remain idempotent.

These are best-effort read-time views, not a distributed consistent snapshot or
reservation. Concurrent changes detected while constructing context return 409;
queue assembly drops changed/hidden items. Changes after the response can still
occur. The decision endpoint's expected version and evidence checks remain essential.
Candidate enumeration is currently unpaginated and intended only for the small
local dataset. R7 must supply scoped indexes/pagination and real transaction semantics
before production scale. No durable read-access audit/security logging is added.

### Fictional responses for R1

For a verified fictional clinician, GET /api/reviews/queue?category=CLINICAL:

```json
{
  "category": "CLINICAL",
  "items": [{
    "requestId": "fictional-001",
    "category": "CLINICAL",
    "workflowVersion": 7,
    "status": "WAITING_FOR_CLINICAL_APPROVAL",
    "request": {
      "requestId": "fictional-001",
      "revision": 1,
      "snapshotHash": "0de6a9d3c1fb64bc258d9252c371c2faa5639f39858ef32b155346727402b952"
    }
  }]
}
```

Selected fields from GET /api/requests/fictional-001/review-context?category=CLINICAL:

```json
{
  "category": "CLINICAL",
  "workflowVersion": 7,
  "eligibility": {"eligible": true, "reasons": []},
  "checker": {
    "logicRevision": 1,
    "logicHash": "b8da115e6b0ab7e04e56dcb9d4d1167e2b34a481c7c5a0dcbdbd87f22aa103f1",
    "reportId": "checks-6",
    "passed": true
  },
  "decisionReferences": {
    "expectedVersion": 7,
    "requestRevision": 1,
    "requestSnapshotHash": "0de6a9d3c1fb64bc258d9252c371c2faa5639f39858ef32b155346727402b952",
    "logicRevision": 1,
    "logicHash": "b8da115e6b0ab7e04e56dcb9d4d1167e2b34a481c7c5a0dcbdbd87f22aa103f1",
    "checkerReportId": "checks-6"
  }
}
```

The full context also includes the LogicModel snapshot and common fields described
above. A release context in this fixture has workflowVersion 12 and includes
clinicalApprovalEventId `event-7-CLINICAL_DECISION`, compilationId `compile-8`,
verificationId `verify-10` and the exact artifact/report hashes from the test fixture.
Fixed artifact/report hashes are fictional references, not evidence of compilation.
An authorized self-review context instead includes:

```json
{
  "eligibility": {"eligible": false, "reasons": ["SELF_APPROVAL"]},
  "decisionReferences": null
}
```

R1 should render category-specific snapshots and findings, display eligibility
reasons, disable unsupported actions, and refresh after 409 or a successful decision.
Retain the exact references and workflow version when creating a decision; use a
fresh eventId per intent and preserve it for retry. Queue rows deliberately omit
private ownership/history. SD currently has a read screen only; a separate authorized
clarification-write service is still needed before adding an SD action button.

### Pending Role 4 and Role 7 Integration

All contracts remain provisional and package-local. R4 must confirm category/state/
error vocabulary, snapshot/checker/clinical/verification reference shapes, expression
and ambiguity validation and richer blocking-finding records. Existing snapshot
validation remains provisional, not full clinical correctness validation. Request,
LogicModel and artifact identities remain distinct.

R7 must confirm verified session/service identity, global reviewer-role scope,
tenant/request membership, assignment ownership (if any), and durable indexed reads.
Any future assignment policy must also be enforced on decision submission; this
milestone does not implement assignment storage or claim production authorization.
Coordinate durable store transactions, revision integrity and operational read-access
logging. The local in-memory store and mock identities provide no real authentication,
distributed transactions or durable persistence.

Verification: 568 passing tests (468 preserved + 100 new reviewer service/HTTP tests),
strict TypeScript with zero errors. Tests use Fastify inject() and fictional data.
Actual Node 22 runtime verification remains pending; this environment uses Node 24
with Node 22 typings. No dependencies or shared configuration were changed.

Next milestone: an explicit routing application service that loads current screening
and PO confirmation, computes the existing routing result, and commits APPLY_ROUTING
through store.apply() with version/idempotency checks. Add a small mocked downstream
handoff port bound to the accepted request revision and LogicModel references;
coordinate the R3 drafting/R4 checker/R5 compiler/R6 verification contracts before
real adapters. Routing must not silently dispatch jobs, compile or bypass approval.
A durable outbox/worker handoff can follow with R7 once persistence is selected.

## Explicit routing application service (local milestone)

`RoutingService` in src/routing-service.ts connects the existing pure Routing Box
to APPLY_ROUTING through store.apply(). It introduces no second state machine,
review assignment, compilation, AWS call or job dispatch. Pass it as the optional
`routing` dependency of createLocalApi(); authentication remains deny-by-default,
and the factory still exposes inject()/close() without a public listener.

Execution is explicit: resolve the verified server actor and request visibility,
load current state and the immutable preview, verify accepted screening/owner PO
confirmation records, call routeDesignBrief(), and atomically commit the existing
workflow transition. Command revision/hash and expected workflow version must match.
Cached COMPLETED/CONFIRMED flags alone are insufficient: exactly one matching accepted
record of each kind must exist for the same current request revision/hash and IDs.
The preview's content must also match the stored brief. Missing, duplicate, failed,
incomplete, stale or conflicting evidence blocks routing.

| Routing result | Effect |
| --- | --- |
| NOT_READY | 409 with structured reasons; no state advancement, receipt, SD queue item or job. An authorized blocked attempt is audited as rejected. |
| NEEDS_SD_REVIEW | Commit the existing NEEDS_SD_REVIEW workflow state. The existing authorized SD queue discovers it; no individual assignment is created. |
| READY_FOR_BEDROCK_REVIEW | Commit the existing READY_FOR_LOGIC_PROPOSAL workflow state. Nothing invokes Bedrock or starts logic drafting. |

PO confirmation and preliminary screening are not clinical approval. Independent
clinician, compilation, verification and separate release gates remain unchanged.
The state machine revalidates the routing result at commit and rejects attempts in
other states. Routing with a new event ID after a successful route does not skip the
next guarded workflow step.

### Provisional authorization policy

The default requires a server-resolved ORCHESTRATOR role, consistent with the
existing workflow guard. An optional authorizeActor(actor, requestId) dependency can
restrict that permission further (for example, to approved internal identities).
It cannot elevate PO/SD/clinician actors past the workflow's mandatory ORCHESTRATOR
role. A future human-trigger permission must be agreed with the team; a verified
human would need an explicitly authorized role or a deliberate shared guard change.
No browser role/actor/trusted claim establishes authority.

canAccessRequest is a required injected backend policy, with no allow default; use
the same request/tenant visibility policy as the HTTP authentication boundary.
Visibility is checked before private reads and again before apply(). The extra actor
policy is also checked again. The store re-resolves the actor, compares expectedActorId
and runs current workflow role/version guards. Its real identity resolver must enforce
current request membership at commit as well. The current mocks and in-memory store
do not provide real authentication or distributed authorization guarantees.
Malformed, inaccessible or role-denied calls stop before storage; operational security
logging for those attempts remains pending. Well-formed NOT_READY/stale/conflicting
commands submitted to apply() append rejection audits when storage is available.

### HTTP contract and retries

```http
POST /api/requests/fictional-001/route
Content-Type: application/json
```

Fictional body for a confirmed preview at version 3:

```json
{
  "eventId": "fictional-route",
  "expectedVersion": 3,
  "revision": 1,
  "snapshotHash": "0de6a9d3c1fb64bc258d9252c371c2faa5639f39858ef32b155346727402b952"
}
```

requestId comes from the path. The body accepts only those four fields. Screening,
confirmation, computed routes, assignments, dispatch flags, roles and identities must
not be supplied. Unknown body/query fields, invalid hashes and coerced/fractional
versions are rejected. The existing body size and identifier limits apply.

For clear fictional screening, the full 200 response is:

```json
{
  "status": "SUCCESS",
  "reason": "APPLY_ROUTING",
  "requestId": "fictional-001",
  "eventId": "fictional-route",
  "workflowVersion": 4,
  "auditId": "[\"fictional-001\",\"fictional-route-attempt\"]",
  "routing": {
    "route": "READY_FOR_BEDROCK_REVIEW",
    "requestId": "fictional-001",
    "revision": 1,
    "snapshotHash": "0de6a9d3c1fb64bc258d9252c371c2faa5639f39858ef32b155346727402b952",
    "screeningId": "screen-1",
    "confirmationId": "confirm-1",
    "reasons": [{
      "code": "READY_FOR_AI_REVIEW",
      "field": "brief",
      "message": "Current screening and PO confirmation match. Downstream review may be scheduled separately; clinician approval, developer verification, and release approval remain mandatory."
    }],
    "clinicalApprovalRequired": true
  }
}
```

The example uses a deterministic fictional attempt ID; normal attempts use backend
UUIDs. Snapshot hashes are computed by the existing snapshot module, not invented
by routing logic. Read current workflow status separately; the example state is now
READY_FOR_LOGIC_PROPOSAL, with no LogicModel or clinical/release approval yet.

When current screening contains the fictional clinical concern from the tests, the
route is NEEDS_SD_REVIEW with REVIEW_REQUIRED reasons referencing
screening.checks.clinicalSafety. GET /api/reviews/queue?category=SERVICE_DESIGNER through
a verified fictional SD session returns:

```json
{
  "category": "SERVICE_DESIGNER",
  "items": [{
    "requestId": "fictional-001",
    "category": "SERVICE_DESIGNER",
    "workflowVersion": 4,
    "status": "NEEDS_SD_REVIEW",
    "request": {
      "requestId": "fictional-001",
      "revision": 1,
      "snapshotHash": "0de6a9d3c1fb64bc258d9252c371c2faa5639f39858ef32b155346727402b952"
    }
  }]
}
```

The existing SD review-context API exposes the corresponding screening findings and
clarification reasons. NOT_READY never creates this item. Its 409 response contains
`error.code: NOT_READY` and a routing object with field-specific reason codes/messages;
there is no accepted routing receipt. Repeating the same blocked command cannot
advance state. Changed prerequisites increment workflow version, requiring a fresh
command based on the new current state.

HTTP conventions: 200 committed success or identical accepted retry, 400 malformed
command, 401 missing authentication, 403 unsupported actor/policy, generic 404 for
missing/inaccessible requests, 409 stale versions/revisions, conflicting event or
wrong state, and sanitized 503 for storage/provider failures. Uncommitted valid routes
are not returned as success. Responses retain Cache-Control: no-store.

The command fingerprint covers all command fields and the verified initiating actor
ID. An identical accepted retry returns DUPLICATE_EVENT with the original routing
result; changed command fields or another actor under the same accepted event ID
conflict. A receipt recheck closes the race between separate receipt/state reads:
a concurrent identical commit is replayed rather than rejected as a stale preflight.
The store's atomic version check still ensures distinct concurrent commands cannot
advance the same version twice. Exact retries after later revisions acknowledge only
the historical route: they never restore old state, screening, confirmation or queues.
The returned workflowVersion may therefore be current while routing refers to an older
accepted preview. Fetch current status before further actions.

### Atomic routing records and Pending Role 4 Integration

AuditRecord and EventReceipt now have optional routing: RoutingResult fields. The
in-memory adapter copies the full validated routing decision into both only after
an accepted APPLY_ROUTING transition, in the same atomic operation as state, receipt
and audit. This retains reasons, screeningId, confirmationId and exact preview
revision/hash after later revisions. The referenced screening/confirmation records
already remain immutable in evidence history. Returned copies cannot mutate stored
history. No separate routing record map or second persistence operation was added.
Rejected attempts do not assert an accepted routing payload in their audits; detailed
NOT_READY reasons are returned to the caller. Failed commits leave no partial records.

The optional fields preserve old/non-routing record compatibility. Older raw workflow
routing receipts without the new application fingerprint cannot be silently claimed
as application retries. An application retry whose stored routing payload is missing
fails closed. R7's future durable adapter must preserve these routing fields atomically,
not discard them as optional metadata.

R4 must finalize the command/receipt/audit schemas, evidence ID scope, hash policy,
state/route terminology and structured error vocabulary. The service still uses
provisional orchestrator-local contracts and the existing snapshot-validation boundary.
Role 3 owns screening content and must eventually supply authenticated evidence;
Role 2 does not implement model assessment. Team/R7 agreement is still needed on
internal identities, any permitted human routing roles and request/tenant access at
commit. No real auth or durable database transaction is claimed.

Verification: 665 passing tests (568 preserved + 97 new service/HTTP tests), strict
TypeScript with zero errors, and fictional Fastify inject() scenarios without a
listener. Tests cover blocked evidence, SD discovery, concurrency including the
receipt/state race, immutable history, rollback and unchanged downstream gates.
Node 22 runtime verification remains pending; the local environment is Node 24 with
Node 22 typings. No dependencies or root/shared configurations changed.

Smallest next step: a mocked, explicit version-bound proposal-handoff service. Load
an accepted routing receipt, verify the current preview/version still matches and
the route permits logic drafting, then create/retry a synthetic handoff keyed by
routing event ID and job type. Bind the initial draft job to the request preview;
attach a real LogicModel identity only when one exists. SD/NOT_READY or superseded
routes must never create a drafting handoff. Do not dispatch just because the route
endpoint returns. Add a durable outbox with R7 later when a database adapter is agreed.

## Mocked, version-bound drafting handoffs (local milestone)

`DraftingHandoffService` in src/jobs.ts provides two explicit internal operations:

1. start(command, principal) verifies access, ORCHESTRATOR role, the current immutable
   preview and an accepted clear routing receipt. It atomically records a job intent,
   START_LOGIC_PROPOSAL transition, event receipt and audit. The result is
   INTENT_RECORDED, not worker delivery or completion.
2. deliver(command, principal) loads that recorded job, verifies the current preview,
   DRAFTING_LOGIC state and bound workflow version, and calls an injected worker once.
   It appends a transport audit without advancing workflow or changing job identity.

There is no handoff HTTP endpoint, background worker, retry loop, timer, queue service,
AWS integration or model call. Routing remains separate: returning
READY_FOR_BEDROCK_REVIEW only commits READY_FOR_LOGIC_PROPOSAL. It does not create or
deliver jobs. The existing pure state machine remains unchanged. callbacks.ts is still
an empty placeholder for a later milestone.

### Commands and authorization

The provisional DraftingHandoffCommand contains requestId, eventId, expectedVersion,
revision, snapshotHash and routingEventId. All fields are required, and extra identity,
role, trusted, job ID or job-type fields are rejected. These are internal backend
commands operating on a server-verified principal, never authentication claims from
a browser. The access policy and identity resolver must be the same trusted sources
as the existing application/storage boundaries. Default routing permission remains
ORCHESTRATOR, with an optional restriction hook that cannot elevate another role.

Only a current READY_FOR_LOGIC_PROPOSAL state and its accepted clear routing receipt
can create an intent. The receipt's version, request identity, routing result and
processed-event fingerprint must match authoritative state. The store rechecks the
routing receipt and role/version guards in the atomic commit. Pending/NOT_READY,
Service Designer, missing-route and superseded-preview cases cannot start drafting.
Relevant content revisions still reset eligibility through the existing workflow.

The store requires every accepted START_LOGIC_PROPOSAL to include a matching intent.
When a direct internal command omits it, the store derives it from current state and
the unique committed routing receipt in that same operation. A supplied intent must
match this derived record exactly. This preserves existing internal callers while
preventing a drafting state with no required job record. It does not create jobs on
routing or on any unrelated transition.

start() fingerprints the complete command and verified actor ID. Exact accepted retries
return DUPLICATE_EVENT with the existing logical job. A changed routing reference,
revision/hash/version or actor under an accepted event ID conflicts. Concurrent different
commands cannot consume the same eligible workflow version twice. Job IDs are stable
for request identity, source version and routing event, independent of attempt IDs;
there is also a per-request/source-version uniqueness check in storage. An identical
retry after later revisions acknowledges history without restoring old workflow state
or dispatching work. Job-intent reads verify snapshot integrity and linked receipts.

Well-formed accepted/rejected handoff attempts are audited when storage is available.
Malformed commands and inaccessible resources stop before private storage operations;
operational security logging remains pending. The storage identity resolver must also
enforce current membership/roles at commit. Local mock providers are not real auth.

### Fictional intent and delivery example

After the existing fictional clear route at version 4, submit an internal command:

```json
{
  "requestId": "fictional-001",
  "eventId": "fictional-start-drafting",
  "expectedVersion": 4,
  "revision": 1,
  "snapshotHash": "0de6a9d3c1fb64bc258d9252c371c2faa5639f39858ef32b155346727402b952",
  "routingEventId": "fictional-route"
}
```

start() returns INTENT_RECORDED and this stored fictional job:

```json
{
  "jobId": "draft-4bfe1ceed09f9d7794d4866073273953867ef1dbb6406a19a97bbe7a6725391d",
  "idempotencyKey": "draft-logic-v1:4bfe1ceed09f9d7794d4866073273953867ef1dbb6406a19a97bbe7a6725391d",
  "jobType": "DRAFT_LOGIC",
  "requestId": "fictional-001",
  "requestPreview": {
    "requestId": "fictional-001",
    "revision": 1,
    "snapshotHash": "0de6a9d3c1fb64bc258d9252c371c2faa5639f39858ef32b155346727402b952"
  },
  "sourceWorkflowVersion": 4,
  "workflowVersion": 5,
  "routingEventId": "fictional-route",
  "handoffEventId": "fictional-start-drafting"
}
```

sourceWorkflowVersion is the consumed READY_FOR_LOGIC_PROPOSAL version;
workflowVersion is the new DRAFTING_LOGIC version. A future callback must reference
that job/version and exact preview. Job IDs are SHA-256-derived metadata identifiers,
not new snapshot hashes, credentials or proof of clinical approval. No LogicModel,
patient information or treatment content is generated or embedded in the intent.

Call deliver() separately with requestId, jobId and expectedVersion: 5. An injected
mock worker's first acceptance returns DELIVERED / WORKER_ACCEPTED with
workerOutcome: ACCEPTED. An identical later delivery returns DUPLICATE_DELIVERY /
WORKER_DUPLICATE with the same job ID and key. The workflow remains DRAFTING_LOGIC
at version 5 in both cases; no LogicModel, clinical approval or release approval is
created. No handoff attempt invokes deliver() automatically.

### Worker adapter and transport audit semantics

DraftingWorker.deliver(intent) returns a WorkerResult containing the same jobId and
idempotencyKey, plus one of ACCEPTED, UNAVAILABLE, FAILED or DUPLICATE. A mismatched
acknowledgement fails closed. The isolated test/helpers/mock-drafting-worker.ts simulates
these outcomes and thrown failures; it records fictional delivery IDs only and never
generates or executes clinical logic. No src file imports the mock.

| Worker outcome / condition | Service result |
| --- | --- |
| ACCEPTED | DELIVERED: transport acceptance only, not completed work. |
| DUPLICATE | DUPLICATE_DELIVERY: same logical job recognized. |
| UNAVAILABLE | TEMPORARY_UNAVAILABLE: caller may explicitly retry later. |
| FAILED, thrown exception or invalid acknowledgement | DISPATCH_FAILED: no completion claim. |
| Missing adapter, wrong role or invalid job/state | REJECTED without worker execution. |
| Changed preview/version | STALE_VERSION; an old job cannot be delivered as current work. |
| Storage failure | STORAGE_FAILURE; inspect workerOutcome for acknowledgement ambiguity. |

JobStore extends the existing store with getJob(), listJobs() and recordJobDelivery().
The in-memory implementation uses the existing staged Map replacement and commit
mechanism. Intents are append-only; copies returned to callers cannot mutate stored
records. The handoff receipt links jobId, and the accepted audit includes the intent.
No accepted start can publish only part of state, intent, receipt and audit.

Delivery is a separate external side effect. recordJobDelivery() re-resolves actor
identity and checks the current job/state/version, then appends a DELIVER_DRAFTING_JOB
audit without calling the workflow transition or modifying the job. Audit attempt IDs
are idempotent and immutable. Transport audits include jobId and worker outcome;
ACCEPTED here means transport acknowledgement, never human clinical/release approval.
Failed/unavailable/rejected transport attempts are logged as rejected without changing
authorized state. A new manual delivery attempt has a new audit attempt ID but the
same logical job/idempotency key. No COMPLETED transport outcome is supported.

The worker call and local audit cannot be one transaction. If a worker accepts but
recording its audit fails, STORAGE_FAILURE preserves workerOutcome: ACCEPTED. If an
acknowledgement is lost, the caller may not know whether acceptance happened. Retry
must reuse the same ID/key and the worker must deduplicate. If a request changes
during delivery, the audit may reject current eligibility while preserving the actual
worker outcome. Already-sent work cannot be recalled by this adapter. Workers and
future callback ingestion must reject superseded output before accepting results.
The persistent intent is never deleted to hide such ambiguity.

### Role 3, Role 4 and Role 7 integration

R3 must implement the replaceable worker adapter, accept the exact version-bound
envelope and durably deduplicate by stable job ID/key and payload. Authenticate any
snapshot retrieval and fetch/verify the referenced immutable preview. Do not treat
transport acceptance as successful drafting. Return a separately authenticated,
version-bound result callback later; generated LogicModel content must go through
R4 validation/checking and independent clinician approval before compilation.

R4 must finalize envelope/schema versions, job ID/idempotency scope, snapshot metadata,
result/error contracts and official LogicModel validation. Contracts remain local and
provisional. Request preview identity and future LogicModel/artifact identities remain
separate; this milestone never invents a LogicModel or artifact hash.

R7's durable adapter must guarantee conditional workflow versions, immutable snapshots,
unique logical job per eligible request/version, atomic state+intent+receipt+audit writes,
and durable retry receipts. Transport audits must be append-only and authenticated.
A real durable intent/outbox scanner and worker-side idempotency are needed for crash
recovery and at-least-once delivery. No exactly-once network delivery or distributed
transaction is claimed. Real auth/membership enforcement, database/job infrastructure,
leases and retry scheduling remain pending. The current maps and mock-worker dedup
state disappear on process restart.

Verification: 748 passing tests (665 preserved + 83 new handoff/transport tests), strict
TypeScript with zero errors. No dependency installation, root configuration or other
package changes were needed. Tests include atomic rollback, concurrent starts/delivery,
revisions, unavailable/failing workers and acknowledgement ambiguity. Actual Node 22
runtime verification remains pending; local checks use Node 24 with Node 22 typings.

Smallest next milestone: define an internal authenticated Role 3 drafting-result
callback carrying job ID, event ID, expected workflow version, exact preview identity
and a proposed LogicModel snapshot. Load and verify the stored intent, reject stale/
wrong-job results, use the replaceable R4 schema boundary, and atomically commit the
existing LOGIC_PROPOSED event, immutable model, receipt and audit. Test duplicate
callbacks, revision races, wrong roles and rollback before adding any network endpoint
or AWS adapter. This milestone leaves callbacks.ts unchanged.

## Internal authenticated drafting-result ingestion (local milestone)

callbacks.ts now exports DraftingCallbackService.ingest(command, principal). No
callback service previously existed. This is an internal application boundary, not
an HTTP route: server.ts and the existing deny-by-default authentication boundary
are unchanged. There are no AWS calls, generated clinical content or new dependencies.
The service uses the existing LOGIC_PROPOSED transition and canonical snapshot utilities.

The lifecycle is: authenticate a verified worker context, authorize DRAFTER and job
scope, load the immutable stored drafting job/handoff, compare current request and
workflow identities, validate/hash the proposed LogicModel, obtain required injected
R4 evidence, then atomically commit the proposal and accepted result. The existing
state transition is DRAFTING_LOGIC -> WAITING_FOR_LOGIC_CHECKS. No LOGIC_CHECKED,
clinical approval, compilation or release event is inferred from callback acceptance.

### Worker identity, job and command bindings

DraftingResultCommand contains requestId, jobId, eventId, expectedVersion,
sourceWorkflowVersion, revision, snapshotHash, schemaVersion and logicModel. Extra
roles, actor IDs, trusted flags, validation assertions, client-computed model hashes
and approval fields are rejected. The principal is a separate opaque server context
resolved by the injected identity provider; it is never taken from the payload.

A verified actor must have DRAFTER, have access to the request, and satisfy the
optional authorizeWorker(actor, job) restriction. The job must be DRAFT_LOGIC. No
individual worker assignment is invented. Visibility and identity/job authorization
are checked again after validation, and the store re-resolves actor/role at commit.
Real R7 identity resolution must enforce request/job membership at that boundary.

The service verifies these stored facts rather than trusting completion claims:

- getJob(requestId, jobId) finds the scoped immutable intent; its snapshot and
  routing/handoff receipt bindings are verified by the existing store reader.
- The callback's revision/hash match the job preview and current stored request.
- expectedVersion equals both the active DRAFTING_LOGIC state and job.workflowVersion.
- sourceWorkflowVersion matches the READY_FOR_LOGIC_PROPOSAL version consumed by
  that handoff, and the accepted handoff receipt references the same job/preview.
- A job already accepted under another callback cannot receive a conflicting result.

A recorded transport acceptance is not required: a worker acknowledgement can be
lost. The authenticated, validated result must still bind to a real committed intent.
Missing/unknown jobs cannot fabricate state advancement, and wrong-request lookups
do not disclose another request's evidence. Malformed and unauthenticated commands
stop before storage; authenticated rejected attempts are audited when access/storage
permit. Provider/storage outages fail closed without exposing exception details.

Test-only opaque service principals and fictional R4 evidence live exclusively in
test/helpers/callback-fixtures.ts. Its identity provider recognizes exact object
instances, not matching session/roles/trusted properties supplied by callers. No
source file imports this fixture or claims to implement real service authentication.

### Replaceable R4 validation boundary

callback-contracts.ts defines metadata contracts, not a competing LogicModel schema.
LogicValidationBoundary has validateSnapshot (the existing synchronous, nontransforming
SnapshotValidator) and validateProposal (an injected R4 schema/checker adapter returning
structured evidence). There is no pretend-success default when this boundary is absent.

The snapshot module validates strict JSON and creates a frozen LOGIC_MODEL snapshot
using initial logic revision 1, the exact request preview, supplied schemaVersion and
the existing jcs-sha256-v1 policy. All content, including sources, citations and ordered
rule arrays, remains covered by the computed SHA-256 hash. R2 never supplies medical
rules or interprets the LogicModel. Test data uses the pre-existing fictional training
model and provisional shape validator only.

PASSED validation evidence must contain validatorId, validatorVersion, resultId,
optional reportId, requestId, exact requestPreview, exact logic revision/hash,
schemaVersion and hashPolicyVersion. Metadata must bind to the computed frozen
snapshot. Unknown or mismatched fields, missing required evidence, null/unavailable
validation or adapter failures block acceptance. Malformed/unsupported model content
is rejected. Failed validation rejects the proposal without marking the job accepted.
Available validator/result/report references are preserved on rejected validation
audits as audit-only traceability, not passing checker evidence.

The fictional adapter is isolated in tests and is not a clinical checker. R4 still
owns official schema/checker implementation and result provenance. This milestone
records validation needed to admit a proposal; it does not automatically turn that
report into the separate authoritative LOGIC_CHECKED workflow evidence required by
the existing clinician gate. Agree with R4 whether and how an actual report may be
adopted through that next explicit transition. Even a passing formal checker report
would not replace independent clinician or release approval.

### Atomic acceptance and duplicate delivery

DraftingResultStore extends the job read port with getDraftingResult(requestId, jobId).
Acceptance is written only through the existing apply() operation. ApplyCommand can
carry draftingResult plus immutable snapshots; EventReceipt and AuditRecord retain
the exact accepted result. The in-memory adapter stages the model snapshot, current
state, one job-result record, receipt and audit together, then publishes one Map
replacement. Failed commits leave no accepted result marker or partial snapshot/state.
The immutable job intent remains separate from its accepted result record.

The store rechecks handoff/current-job bindings, validation metadata, model identity,
result-record shape and one accepted result per job. An application LOGIC_PROPOSED
command with a command fingerprint cannot omit its callback result metadata. Trusted
legacy raw workflow commands without application fingerprints remain compatible with
existing local fixtures; they do not create authenticated callback-result records.
Those low-level fixture paths must not be exposed to workers/browser clients. A real
adapter must restrict writes to the authenticated application boundary and enforce
its job/result evidence requirements.

The complete callback payload and verified actor ID are fingerprinted with canonical
JSON. Identical accepted retries return DUPLICATE_EVENT with the original model,
validation references, accepted workflow version and original auditId, even after
later request revisions. attemptAuditId identifies the current duplicate/rejection
attempt's audit. The original result is acknowledged without restoring stale state
or re-running R4 validation. Changed content/evidence under an accepted event ID
conflicts. Stable service identity across retries is an R7 integration requirement.

Concurrent distinct results cannot both consume the same drafting version. A second
receipt check handles an identical callback committing between separate receipt/state
reads; the original committed result is replayed. Revisions during asynchronous R4
validation are rejected by the store's final version check. getDraftingResult() verifies
linked job, model snapshot, validation metadata and accepted receipt on every load.

Result statuses are ACCEPTED, DUPLICATE_EVENT, BLOCKED, REJECTED, STALE_VERSION and
STORAGE_FAILURE. Missing R4 evidence returns BLOCKED / VALIDATION_UNAVAILABLE;
mismatched report bindings return BLOCKED / INVALID_VALIDATION_EVIDENCE. No failure
response claims a proposed model or accepted job result. A failure reading acceptance
back after a successful commit may still return STORAGE_FAILURE; retrying the identical
command safely resolves that uncertainty.

### Fictional callback examples

With the isolated verified worker principal, ingest this fictional result:

```json
{
  "requestId": "fictional-001",
  "jobId": "draft-4bfe1ceed09f9d7794d4866073273953867ef1dbb6406a19a97bbe7a6725391d",
  "eventId": "fictional-drafting-result",
  "expectedVersion": 5,
  "sourceWorkflowVersion": 4,
  "revision": 1,
  "snapshotHash": "0de6a9d3c1fb64bc258d9252c371c2faa5639f39858ef32b155346727402b952",
  "schemaVersion": "1.0",
  "logicModel": {
    "schemaVersion": "1.0",
    "pathwayId": "fictional-training",
    "title": "Fictional model 1",
    "language": "en",
    "sources": [{"id":"fictional-guide","title":"Fictional training guide"}],
    "context": [],
    "questions": [{"id":"complete","type":"boolean","label":"Fictional training complete?"}],
    "derived": [],
    "decisionTables": [{"id":"classification","hitPolicy":"first","rows":[],"otherwise":"complete"}],
    "outcomes": [{"id":"complete","label":"Training complete","referral":"none"}],
    "ambiguities": []
  }
}
```

Selected fields from the accepted response:

```json
{
  "status": "ACCEPTED",
  "reason": "LOGIC_PROPOSED",
  "workflowVersion": 6,
  "result": {
    "jobWorkflowVersion": 5,
    "acceptedWorkflowVersion": 6,
    "logic": {
      "logicRevision": 1,
      "logicHash": "b8da115e6b0ab7e04e56dcb9d4d1167e2b34a481c7c5a0dcbdbd87f22aa103f1"
    }
  },
  "validationReference": {
    "validatorId": "fictional-r4-validator",
    "validatorVersion": "fixture-v1",
    "resultId": "fictional-validation-b8da115e6b0ab7e0",
    "reportId": "fictional-report-b8da115e6b0ab7e0"
  }
}
```

The workflow is now WAITING_FOR_LOGIC_CHECKS with no clinical/release approval.
The full result also contains job/request/handoff identities, validation bindings
and audit references. All snapshot hashes above were computed from fictional data.

If the PO materially revises the request before this result is accepted, the same
late callback instead returns these selected fields:

```json
{
  "status": "STALE_VERSION",
  "reason": "VERSION_CONFLICT",
  "result": null,
  "workflowVersion": 6,
  "validationReference": null
}
```

That separate scenario remains WAITING_FOR_SCREENING on the new preview, with no
accepted result for the old job. A callback already accepted before a later revision
is acknowledged as a historical duplicate instead; it never restores the old model.

### Remaining integration and next milestone

R3 must send the exact recorded job/preview/source version, retain callback event IDs
for retries and submit data through real verified service authentication. It must not
provide trusted flags or its own validation/approval authority. R4 must finalize the
model schema, deterministic validation/report protocol, metadata ID scope and schema/
hash-policy migration support. These contracts remain package-local and provisional.

R7 must provide real service identity, job/tenant permissions and durable conditional
transactions. Enforce unique accepted result per logical job and atomically preserve
snapshot, workflow, result marker, receipt and audit. Keep historical snapshots and
validation versions readable. The current in-memory fake is volatile, not a durable
or distributed database. No production HTTP callback, real authentication, AWS service,
background execution or deployment was added.

Verification: 825 passing tests (748 original + 77 new callback tests), strict
TypeScript with zero errors and clean whitespace checks. Runtime: Node v24.18.0,
with existing Node 22 typings. Actual Node 22 execution remains pending. All existing
routing, workflow, snapshot, request, reviewer, approval and handoff test files are
unchanged. No root/shared configuration or dependency installation was needed.

Smallest next milestone: authenticated, version-bound R4 checker-result ingestion
using the same pattern to record LOGIC_CHECKED with exact current LogicModel/report
bindings. Then add R5 compilation and R6 verification result services bound to approved
model and actual artifact identities. Keep clinician approval mandatory before
compilation and separate release approval mandatory after verification; add no model
calls, generic trusted-flag callbacks or production endpoints until identity/storage
contracts are ready.

## Formal R4 checker-result ingestion (local integration)

`src/checkers.ts` provides an internal `CheckerResultService`; there is no checker
HTTP endpoint, listener, worker execution, AWS connection or default mock identity.
The fictional adapter and opaque service sessions live only in
`test/helpers/checker-fixtures.ts`. The existing server-side identity resolver and
request-visibility policy must be injected. Caller-supplied actors, roles and trust
flags are rejected. An authenticated CHECKER role alone is insufficient: its actor
ID must match the server-configured target recorded on the invocation.

The lifecycle is:

```mermaid
stateDiagram-v2
  WAITING_FOR_LOGIC_CHECKS --> WAITING_FOR_LOGIC_CHECKS: Authorize exact checker invocation (metadata only)
  WAITING_FOR_LOGIC_CHECKS --> WAITING_FOR_LOGIC_CHECKS: Unavailable / incomplete (blocked attempt)
  WAITING_FOR_LOGIC_CHECKS --> WAITING_FOR_CLINICAL_APPROVAL: LOGIC_CHECKED / formal passing report
  WAITING_FOR_LOGIC_CHECKS --> FAILED: LOGIC_CHECKED / failed or blocking report
  WAITING_FOR_CLINICAL_APPROVAL --> CLINICALLY_APPROVED: Independent human clinical decision
```

1. The internal ORCHESTRATOR calls `authorize(command, principal)` while the current
   model is `WAITING_FOR_LOGIC_CHECKS`. The command has requestId, eventId,
   expectedVersion, revision, snapshotHash, logicRevision and logicHash. The backend
   supplies the checker actor ID, checker ID and checker version from trusted
   configuration, not from this command. A stable invocation ID, authorization
   receipt and audit are recorded atomically without advancing the workflow or
   dispatching a job. Only one invocation is authorized per exact proposal.
2. R4 returns `ingest({ ...command, eventId: resultEventId, invocationId, report },
   verifiedWorkerPrincipal)`. Use a different event ID for authorization and result.
   Its report includes reportId, resultId, requestId, requestPreview, logic,
   invocationId, checkerId, checkerVersion, outcome, findings and references.
   Findings retain id, code, severity, blocking, message and references. These are
   transport/provenance checks; this service does not run R4's checker algorithms.
3. Ingestion checks the stored invocation, worker, current request/model identities,
   workflow version and hash-verified immutable model. It uses the existing
   `LOGIC_CHECKED` transition, then atomically saves report, evidence, state, accepted
   receipt and audit. The original drafting admission-validation report is separate;
   it never substitutes for this formal completion.
4. Report outcomes PASS, FAIL and ERROR are completed results. Policy
   `r2-conservative-check-v1` permits only PASS with no blocking findings and no
   WARNING or ERROR severity findings. INFO findings must also be nonblocking.
   PASS with a warning is retained unchanged but mapped to `passed: false`.
   FAIL/ERROR likewise enter the existing FAILED state. No clinical interpretation
   or medical threshold is invented by this mapping.
5. UNAVAILABLE and INCOMPLETE return BLOCKED without changing workflow or saving an
   accepted report. Their well-formed attempts are retained in audit history. A
   changed/completed result needs a new event ID; an identical blocked retry stays
   blocked. Recovery after a completed failed check requires a relevant revision
   under the existing state machine; no automatic recheck or retry loop is added.

### Fictional examples

The tests seed request `fictional-001`, preview revision 1, LogicModel revision 1,
workflow version 6. The model hash computed from the fictional training model is
`b8da115e6b0ab7e04e56dcb9d4d1167e2b34a481c7c5a0dcbdbd87f22aa103f1`.
Its server-recorded invocation is
`check-97779b118ccc62112f22900cb3d0d625000ccb7185648626169939b9b7f86f2a`.
The test adapter returns report `fictional-formal-report`, result
`fictional-formal-result`, checker `fictional-r4-checker`, version `fixture-v1`.

Separate fixture scenarios produce these abbreviated responses:

```json
{"status":"ACCEPTED","reason":"CHECKS_PASSED","workflowVersion":7,"result":{"passed":true}}
```

The clinical queue now includes the request at version 7. Its authorized context
has `eligibility.eligible: true`, the exact model hash, checkerReportId and decision
references required by the existing approval API. It still has no clinical approval.

A report with a fictional source-reference warning (even with `blocking: false`)
is accepted as evidence, but does not authorize clinical approval:

```json
{"status":"ACCEPTED","reason":"CHECKS_BLOCKED","workflowVersion":7,"result":{"passed":false}}
```

The workflow is FAILED and excluded from the active clinical queue. An authorized
clinician can still request the current review context: `checkerReport` preserves
all findings and source references, eligibility includes `CHECKER_BLOCKING_FINDINGS`,
and decisionReferences is null. Queue/context reads do not write events. The HTTP
response schema preserves the report fields. Approval submission independently
rechecks the formal evidence as well as the existing independence and workflow guards.

A result submitted after the model/request revision changed is rejected:

```json
{"status":"STALE_VERSION","reason":"VERSION_CONFLICT","result":null}
```

No old report unlocks the new revision. Previously accepted identical retries return
DUPLICATE_EVENT with the original report/version/audit, even after later revisions;
this acknowledges historical completion without restoring old state. Changed content
under an accepted event ID is rejected. Concurrent callbacks can commit only one
outcome for an exact proposal. Failed atomic commits leave no partial report,
receipt, state or audit. Stored reports are append-only, returned as detached copies,
and checked against invocation, snapshot and receipt on reads.

### Pending Role 4 Integration

The report, invocation and finding contracts in `checker-contracts.ts` are provisional
R2 contracts. R4 must agree on schema/version identifiers, findings/reference shapes,
report/result ID scope, checker provenance, and which findings permit clinical review.
Warnings currently block by explicit conservative policy; changing that requires an
agreed policy/version, not silently interpreting them as safe. Agree on recheck and
recovery semantics for the same content, checker-version upgrades, incomplete outcomes,
and report/reference size limits. No R4 schema or checker algorithms were modified.

R7 must supply real service authentication, mapping to an authorized checker target,
tenant/request access and revocation policy. A durable adapter must atomically save
invocations with receipts/audit, and results with state/evidence/receipt/audit; enforce
expected versions, unique invocation and accepted outcome per proposal, report identity
and event-payload conflicts, including blocked attempts. Historical snapshots/reports
must remain immutable and readable. The in-memory adapter is volatile and single-process,
not production distributed transactions or durable authentication.

Older local fixtures retain trusted metadata-only LOGIC_CHECKED events for compatibility.
The authenticated drafting path and proposals with recorded checker invocations require
formal checker evidence even for direct store calls; a bare `passed: true` cannot bypass
that boundary. Never expose raw store.apply(), invocation authorization or legacy fixture
writers as browser/worker APIs. Real database adapters must preserve these restrictions.

Verification: 901 tests pass (all 825 existing plus 76 checker tests), strict TypeScript
has zero errors, and whitespace checks pass. Actual runtime: Node v24.18.0; Node 22
execution remains pending. No dependency, root configuration or shared-schema changes.

Next: add a version-bound compilation intent after CLINICALLY_APPROVED. Bind it to the
exact clinical approval event and LogicModel hash, retain existing START_COMPILATION
and separation guards, and use a mock R5 adapter before adding authenticated compilation
result ingestion. Clinical and separate release approvals remain mandatory.

## Approved compilation handoff (Prompt 24, local integration)

`CompilationHandoffService.start(command, verifiedPrincipal)` in `src/compilations.ts`
uses the same application-service / `store.apply()` pattern as drafting handoffs.
Drafting's typed service and worker transport remain unchanged. This adds a typed
compilation adapter to the same workflow and atomic repository, not a second state
machine, runner, queue, publisher or retry framework. No shared handoff contract was
found in the local `packages/schema`; the new contracts are isolated and provisional.

The internal command contains requestId, eventId, expectedVersion, revision,
snapshotHash, logicModelRevision, logicModelHash and clinicalApprovalId. These are
expected identities, not permission. No URI, baseline, role, actor, status, mode or
trusted flag is accepted from a caller. There is no new HTTP endpoint. Only a verified
ORCHESTRATOR actor with request visibility and any additional injected restriction
may initiate this handoff. A clinician, developer/compiler or release approver is
not elevated to orchestration authority by that role alone.

The service loads current state, immutable preview/model, formal checker evidence,
clinical decision and their accepted receipts. `compilationEvidenceFailure` reuses
ApprovalService's evidence binding check and the original clinical-decision workflow
guard (a discarded pure probe) to recheck reviewer independence, rather than inventing
new approval rules. The existing START_COMPILATION transition is authoritative.
The atomic store repeats evidence/version validation at commit time. Formal checked
paths cannot use bare START_COMPILATION to advance without an intent/outbox.
Metadata-only legacy fixture paths remain compatible for existing tests; do not expose
raw store.apply() as an API. They cannot authorize this new application service.

A valid handoff moves CLINICALLY_APPROVED to COMPILING and atomically records:

- Workflow version and compilationId (the compilation jobId).
- Immutable COMPILE_LOGIC intent, mode approved, initial local job status PENDING.
- Accepted event receipt and audit with exact evidence references.
- Thin `JOB#<jobId>` / `OUTBOX` record pointing to the authoritative job.

The job ID/idempotency key is derived from the exact request-preview identity, model
revision/hash and clinical approval event. Delivery attempts cannot generate new logical
jobs. Request revision, LogicModel revision, source workflow version and resulting
workflow version are separate fields. `clinicalApprovalId` maps to the existing accepted
CLINICAL_DECISION **eventId**, scoped by requestId; no separate approval ID was invented.

Identical accepted retries return the original job, timestamp, receipt audit ID and
version, without resolving S3 again. They remain historical acknowledgements after
later revisions and never restore an old state. Changed commands under the same event
ID conflict. Different events competing for one version cannot both commit. Rejected
attempts are audited where identity/access/storage allow; no job/outbox is created.
Storage faults leave state, job, receipt, audit and outbox uncommitted together.
An S3-first upload may remain orphaned after a failed DynamoDB transaction; it is not
an authorization. No cleanup/deletion process is added.

### Immutable object representation and S3-first boundary

`LogicModelReferenceProvider.getVerifiedReference(snapshot)` is a trusted backend port.
There is no default production implementation. R7 must upload/locate and verify an
immutable, private, encrypted, versioned object before returning this reference.
The test-only adapter uses an in-memory fictional object registry and verifies bytes;
it does not access S3. The service rejects missing/unsupported references and requires
matching request/model identities, byte hash/length, policy/representation, object
version, verification record ID and `s3://<bucket>/snapshots/<hash>.json` URI.
These metadata checks cannot themselves prove an S3 object exists: the injected server
adapter must actually verify it and enforce allowed bucket, tenant and object version.
Client flags must never implement that provider.

Existing `jcs-sha256-v1` hashes UTF-8 RFC 8785 canonical JSON of the **entire snapshot
envelope excluding snapshotHash**, including kind, requestId, LogicModel revision,
schemaVersion, hashPolicyVersion, requestPreview and full content. `logicObjectBytes()`
returns precisely these bytes and checks SHA-256 against the approved snapshotHash.
The reference declares representation `r2-snapshot-envelope-without-hash-v1`.
`logicModelHash` equals the SHA-256 of those object bytes. It is neither the hash of
raw LogicModel content alone nor of an envelope containing its own snapshotHash.
R7 downloads the pinned version and verifies SHA-256/length before R5 extracts content.
Do not reformat, normalize, omit sources, or hash the object including snapshotHash.

This byte format is an explicit provisional adapter, not an assertion that R5/R7 have
adopted it. If their existing object format is raw LogicModel JSON or a full envelope
including snapshotHash, agree on a migration or separate object hash; do not silently
change approved hashes. No real object URIs or baseline hashes are generated by the
service. There is no authoritative baseline record locally, so baselineHash is omitted.
R5 currently does not support baseline comparison. The first integration must not
require baselineHash. Baseline diff and renamed-field detection remain future work,
using an authoritative baseline only if that capability is agreed later.

### Fictional job and outbox example

The fixture records request revision 1 / LogicModel revision 1 at source workflow
version 8 and transitions to COMPILING version 9. These are synthetic training data.
The following is the core payload; the actual intent additionally preserves
requestPreview, snapshotReference (versionId, verificationId, representation, hash
policy, byte hash and length), checkerInvocationId and handoffEventId.

```json
{
  "jobId": "compile-515c9eeb6cf47fd7392b9fd05414cf427e8c9f7d12342bb61524e75dcc612e97",
  "jobType": "COMPILE_LOGIC",
  "mode": "approved",
  "requestId": "fictional-001",
  "revision": 1,
  "logicModelRevision": 1,
  "logicModelHash": "b8da115e6b0ab7e04e56dcb9d4d1167e2b34a481c7c5a0dcbdbd87f22aa103f1",
  "logicModelUri": "s3://fictional-local-snapshots/snapshots/b8da115e6b0ab7e04e56dcb9d4d1167e2b34a481c7c5a0dcbdbd87f22aa103f1.json",
  "clinicalApprovalId": "fictional-clinical-approval",
  "checkerReportId": "fictional-formal-report",
  "sourceWorkflowVersion": 8,
  "workflowVersion": 9,
  "idempotencyKey": "approved-compilation-v1:515c9eeb6cf47fd7392b9fd05414cf427e8c9f7d12342bb61524e75dcc612e97",
  "createdBy": "fictional-backend",
  "createdAt": "2026-11-04T12:00:00.000Z",
  "status": "PENDING"
}
```

`getCompilationJob`, `listCompilationJobs` and `getCompilationOutbox` are read-only
internal ports; returned records are detached. The outbox contains pk, sk OUTBOX,
jobId, jobType, requestId, idempotencyKey, createdAt and initial PENDING status, without
clinical content or a second copy of the full job. R7 must load/enrich from
`JOB#jobId / META`; the outbox alone is not a runnable authorization.

### Pending Role 4 / Role 5 / Role 7 Integration

Agree on shared handoff types with the schema owner before adopting them. Outstanding
mappings include the envelope byte format versus raw compiler input, approval eventId
versus R7 approval-record IDs, future optional baseline support, createdBy as the resolved
service actor ID (rather than a magic literal), and R7's exact initial job-status enum.
PENDING is provisional local intent status; no execution status updates exist here.
The older drafting envelope is unchanged and will need separate R7 outbox alignment.
No preview build mode was added or modified.

R7's adapter must use the existing single table and agreed keys: conditionally update
REQ#requestId/META at expected version; check authoritative current approval/checker/
snapshot references; conditionally put JOB#jobId/META, receipt, append-only audit and
JOB#jobId/OUTBOX in one TransactWriteItems operation. Reject existing IDs or conflicting
payloads; keep unique job identity per approval/model and support historical retries.
S3-first references must already be verified and immutable; pin version IDs and use
If-None-Match: * on uploads. Job/outbox records here carry small references, not model
content. The real adapter must keep every DynamoDB item below 400 KB, externalize large
snapshots/reports/history as agreed, and avoid copying unbounded in-memory state blobs
into one item. This milestone adds no DynamoDB schema or infrastructure implementation.

Use R7's Cognito JWT verification and group mapping for humans; internal ORCHESTRATOR
and worker service identity/permissions still require an agreed R7 mapping. The mock
resolvers remain test-only. A developer group must never imply clinical or release
approval authority. R7 owns Streams/Pipes, SQS/DLQ, at-least-once delivery, leases,
heartbeats, retries, offline credential-free COMPILE_LOGIC containers and execution
status in DynamoDB. No components from that list are implemented here.

### Prompt 25: compilation result readiness

Treat `{jobId,status,attempt}` notifications as hints, not artifact or approval evidence.
Load the detailed authoritative job, validate its completed attempt and runner identity,
and match current workflow, compilationId/jobId, request preview, approved model,
clinical approval and immutable artifact manifest/bytes/hash before accepting COMPILED.
Atomically record artifact references/result receipt/audit with the existing transition.
A running job never advances to verification. A successful compilation only reaches
WAITING_FOR_VERIFICATION; independent synthetic-case verification and separate human
release approval remain mandatory before download. R7 must recheck approval has not
been superseded before execution; stale intents are historical, not permission to run.

Local verification: 964 tests passed (all 901 existing + 63 compilation tests), strict
TypeScript zero errors, whitespace clean. Runtime Node v24.18.0; no Node 22 executable
was found on PATH or the inspected Homebrew/nvm/Volta locations. Node 22 execution
remains pending; no runtime installation/root changes were made. No dependencies,
AWS integrations, public endpoint, commits, pushes or deployments were added.

## Compilation-result and artifact ingestion (Prompt 25)

`CompilationResultService` is an internal application service, with no HTTP callback,
queue consumer, compiler, cht-conf execution, R6 harness or AWS adapter. The working
branch began clean at checkpoint `3a63eec`. All existing workflow/approval guards and
964 tests are preserved. Local R5 source files are placeholders, so the supplied R5/R7
contract guides these provisional R2 transport types; no official manifest parser or
R5 hashing algorithm is invented here.

### Trusted completion lifecycle

The command contains only requestId, jobId, eventId, expectedVersion, attempt and
executionRecordVersion. Caller-supplied status, hashes, URIs, roles and trusted flags
are rejected. A verified COMPILER service principal must also satisfy the mandatory
injected R7 runner policy and request-access policy. The runner ID must match the
independently loaded execution record. A human developer role alone grants no access.
The clinician cannot serve as the compiler identity for their approved model.

1. Load the original approved compilation intent and receipt/outbox-backed provenance
   through existing storage, then check COMPILING, current workflow version, request
   preview, LogicModel identity and clinical approval. Reuse
   `compilationEvidenceFailure` to revalidate current clinical/checker evidence and
   their receipts through the existing approval/independence guards.
2. `CompilationExecutionSource.getCurrent()` must read the authoritative R7 job and
   current attempt, not trust a thin SQS notification or cached event status. The R2
   normalized record includes a conditional recordVersion, runner identity, job/input
   bindings, status, attempt, hashes, version-pinned object references, tool versions,
   start/finish timestamps, exit code, cht-conf outcome and exact error/diagnostic data.
3. SUCCEEDED plus compiler exit 0 is necessary but insufficient. An injected
   `CompilationArtifactVerifier` must fetch and verify the pinned actual package,
   manifest and report bytes; validate the R5 manifest; verify complete individual
   file coverage, paths, sizes and hashes from the actual package; check the exact
   approved snapshot and raw-input mapping; preserve compiler/schema/tool metadata;
   and reject inconsistent reports. R2 checks the returned provenance/identity shape
   and bindings again. No verifier/default success, missing objects or unavailable
   evidence means no COMPILED transition.
4. The existing COMPILED event records the packaged artifact hash and advances to
   WAITING_FOR_VERIFICATION. The immutable result, verified artifact/manifest/report
   references, evidence, accepted receipt, workflow and audit commit together via
   store.apply(). Only one result (success OR terminal failure) is accepted per job.
5. Real DynamoDB adapters must condition on the current R7 execution record version,
   attempt and terminal status as part of that same transaction. The in-memory
   adapter requires an injected synchronous `compilationExecutionIsCurrent` condition
   against the test source; absent or changed conditions block acceptance. This closes
   the read/verify/commit race without implementing leases, retries or a second runner.

QUEUED/RUNNING stay blocked. Missing, stale or malformed evidence does not complete
compilation. Identical accepted retries return the original result/version/audit even
when external objects are now unavailable or the request was subsequently revised;
this is historical acknowledgement only. Changed accepted event IDs conflict. Different
concurrent events/attempts cannot publish competing artifacts. Current actor/access
policies are checked again before commit; queue delivery itself never grants authority.

### Four different hashes

- `logicModelHash` / verified artifact `snapshotHash`: R2's existing JCS snapshot-envelope
  hash excluding snapshotHash, including metadata and full model content.
- Execution/artifact `inputHash`: R5's raw LogicModel input digest. The real R5 adapter
  must verify canonical bare JSON (recursively sorted object keys, no whitespace, array
  order preserved, JavaScript JSON.stringify values) against the approved content,
  with conformance established using R5 source or a shared fixture.
- Verified artifact `generatedFilesHash` / normalized execution `compileArtifactHash`:
  R5 manifest artifactHash over generated XLSX and properties JSON, using sorted
  `path<TAB>sha256hex<NEWLINE>` entries. XML and compile-rows are not covered by this
  digest. It is not the packaged archive byte digest.
- Normalized R2 execution `artifactHash` / artifact `packagedObject.sha256`: R7 packageHash, the packaged-object byte
  SHA-256. This is the existing workflow ArtifactIdentity.artifactHash used by later
  version-bound verification/release gates.

Manifest and report bytes have their own digests and version IDs. Full manifest options,
outputs, outcomes and ambiguities remain available at the immutable, hash-verified
manifest reference; they are not silently reduced to an unrelated hash or clinical
approval. No production artifact digest is calculated without real bytes or an
existing authoritative record. The only byte-object implementation is a fictional test
adapter; its raw-input and file-set hash helpers follow the confirmed description but
are **not yet conformance-tested against actual R5 code or a shared R5 fixture**. Its byte strings are not real XLSX/CHT output or archives.
A real adapter must implement archive extraction/coverage verification and R4/R5 schema
validation before returning VERIFIED. The local fixture's separate byte maps simulate
that boundary without compiling or generating actual clinical configuration.

### Fictional accepted record (abbreviated)

```json
{
  "requestId": "fictional-001",
  "jobId": "compile-515c9eeb6cf47fd7392b9fd05414cf427e8c9f7d12342bb61524e75dcc612e97",
  "eventId": "fictional-compiled-result",
  "logicModelRevision": 1,
  "logicModelHash": "b8da115e6b0ab7e04e56dcb9d4d1167e2b34a481c7c5a0dcbdbd87f22aa103f1",
  "clinicalApprovalId": "fictional-clinical-approval",
  "checkerReportId": "fictional-formal-report",
  "acceptedWorkflowVersion": 10,
  "outcome": "COMPILED",
  "execution": { "attempt": 1, "recordVersion": "fictional-execution-v1", "status": "SUCCEEDED", "jobWorkflowVersion": 9, "compilerExitCode": 0, "chtConfStatus": "PASSED" },
  "artifact": {
    "inputHash": "3612ff100eeee4844b9cf3d5bf3f2b977dda8dfce302102bb4bb6aca79585e38",
    "generatedFilesHash": "34febad79c9a2a77658ed12ae12ffcc3225de3ba2f4cde7824120f18a61f7c5b",
    "packagedObject": { "uri": "s3://fictional-compiled-objects/project.tgz", "versionId": "fictional-version-1", "sha256": "a792324535b3e0ac631bd324e3916793fbf08fcc87503acb58cf5512cae1ebc7", "size": 102 },
    "manifest": { "uri": "s3://fictional-compiled-objects/compile-manifest.json", "versionId": "fictional-version-1", "sha256": "9c8be90c7c18c8db523a452abe8abeb038c3cadf9eee330e2fb0d01f80f76140", "size": 869 },
    "compilerVersion": "fictional-compiler-v1", "schemaVersion": "1.0", "stage": "CHT_CONVERTED"
  }
}
```

The full stored result also retains requestPreview (request revision/hash), checker
invocation ID, runner identity, full authoritative execution/error metadata, report
reference, tool versions, verifier provenance and individual file evidence. This is an
internal R6 handoff reference, not an approved download. `getCompilationResult` returns
a detached, integrity-bound historical record and does not start verification.

### Failures and safe progression

Authoritative FAILED/TIMED_OUT/EXHAUSTED results use existing FAIL -> FAILED, preserving
failureKind, compilerExitCode, chtConfStatus, errorCode, exact errorMessage, diagnostics,
log URI and timestamps. Failure kinds distinguish compiler rejection (exit 1), usage/
file diagnosis (exit 2), cht-conf conversion/validation, runner failure, timeout and
exhausted retries. An accepted FAILED result is a recorded failure, never a successful
artifact. No exit-2 transient/retry assumption, new retry policy or automatic revision
is introduced. Faulted failure commits roll back just like faulted successful commits.

A success status with missing/malformed/hash-invalid artifacts remains COMPILING and
returns a blocked/rejected result rather than manufacturing COMPILED or marking
verification passed. Where valid authoritative evidence was loaded, the rejected audit
retains `compilationAttempt` with exact execution metadata and reason. Inaccessible or
unauthenticated requests are denied before evidence access; malformed raw records are
not promoted to trusted audit evidence. Storage outages return STORAGE_FAILURE.

A stale version/attempt returns STALE_VERSION with no artifact/result commit. A changed
request/model invalidates old result eligibility. Raw COMPILED or compilation FAIL
commands on formal job paths require result evidence, not a hash or success flag.
Older legacy fixture paths remain compatible but must never be exposed as public
writers. Clinician approval stays required, and compilation does not populate
verification, release approval or DOWNLOAD_READY.

### Pending R4/R5/R7 integration and Prompt 26

R5 input and generated-file hashing definitions are now clarified, but conformance
still requires published R5 code/shared fixtures. Manifest validation and actual
compiler/tool field mapping remain integration dependencies. R5_GENERATED with
chtConfStatus NOT_RUN cannot pass the current ingestion gate. CHT_CONVERTED requires
explicit successful conversion AND validation plus adapter-verified file evidence.
Where conversion belongs between COMPILE_LOGIC and proposed VERIFY_BUILD still requires
R7 agreement; this conservative hold does not assert a final runner-stage contract.
No cht-conf runs here.

R7 must map its status/attempt records to this provisional view, supplying an immutable
result version, runner identity and all request/model/approval bindings, plus package,
manifest and report content digests and S3 version IDs. Thin job-status events only
trigger authoritative reads. DynamoDB JOB/META status remains R7-owned; the prior
PENDING job intent is historical authorization, not the current execution status.
Use real service authentication, scoped access, strongly current reads and conditional
TransactWriteItems for state/result marker/artifact refs/evidence/receipt/audit. Condition
on execution version/attempt/status as well as workflow version and current approval;
ensure unique accepted result per job. Never persist oversized manifests/diagnostics/
file lists inline beyond DynamoDB limits: use immutable S3 references and agreed bounded
metadata. No infrastructure, new table schema or production adapter was added.

The smallest next milestone is a version-bound R6 verification intent using this accepted
result's exact package byte hash/version, manifest/report references, compilation job/
attempt, model/clinical approval and checker IDs. Require the appropriate output stage,
use existing START_VERIFICATION, and atomically record its intent/outbox. R6 then verifies
synthetic cases; its later authenticated result must not bypass separate release approval.

Original Prompt 25 baseline: 1,057 tests passed (964 prior + 93 ingestion tests); strict TypeScript zero errors;
whitespace checks pass. Actual runtime Node v24.18.0; Node 22 was not found in the
previously inspected local executable locations and was not installed for this milestone.
All new changes remain local and uncommitted. No teammate package, shared schema, root
configuration, AWS service, real compiler/runner, push or deployment was modified.

## Prompt 25 contract reconciliation (R5/R6/R7 clarification)

Inspected baseline: feature/task-2-orchestrator, checkpoint 3a63eec, 11 expected
uncommitted Prompt 25 files, **1,057 passing tests**, zero TypeScript errors. The actual
local compiler source files are empty; packages/verification is absent. Nothing was
fetched, installed or changed outside packages/orchestrator.

Actual gaps corrected: R5-only success previously permitted COMPILED; the fixture used
JSON-array hashing for the generated-file set and unsorted bare-input serialization;
manifestVersion/template.hash were not retained; and initial PENDING/requested mapping
was unspecified. The existing approval/revision/attempt/idempotency/atomic guards and
canonical snapshot envelope representation were already compatible and are preserved.

Targeted corrections:

- `compilation-result-contracts.ts` now retains manifestVersion 1, templateHash,
  explicit conversion/validation evidence and normalized compileArtifactHash. Accepted
  success requires complete build evidence, not the echoed manifest snapshotHash alone.
- `compilation-results.ts` holds R5-only success in COMPILING with BLOCKED /
  BUILD_EVIDENCE_REQUIRED. The trusted verifier must validate manifest, template,
  canonical bare input, files, package and conversion/validation evidence. No missing
  build evidence can be filled by a role/status/URI/hash string from a caller.
- `compilation-integration.ts` maps initial R2 job PENDING to R7 requested explicitly.
  This is an adapter mapping, not a persisted status rename or an outbox delivery state.
  It also maps semantic inputHash / compileArtifactHash / packageHash into the existing
  normalized R2 names. Confirm R7's raw artifactHash meaning in its published schema;
  never assume it is a package digest. The normalized legacy execution/workflow
  artifactHash remains package bytes, preserving existing approval/verification guards.
- Test fixtures now model manifestVersion 1, template.hash (metadata markers excluded),
  compiler XLSX/properties file-list hashing, row/XML evidence separately, and successful
  build conversion plus validation. All original test cases remain; success assertions
  and synthetic fixture evidence were updated for the stricter build requirement.

Canonical S3 bytes need no new storage port: logicObjectBytes plus the existing
LogicModelReferenceProvider already describe the canonical UTF-8 envelope without its
top-level snapshotHash, at snapshots/<logicModelHash>.json. The provider must verify
pinned actual bytes/version, then R7 extracts **content** into /in/logic.json. R5 never
receives the envelope as its model. The full-envelope local snapshot representation
and the proposed S3 object representation intentionally differ in that one hash field.
No S3 serialization/upload/download has been deployed or tested against AWS here.

The confirmed runner stages are R5 in offline credential-free node:22-slim, then
cht-conf in cht-app-ide:v6.6.1 / Node 20. R5 invocation:

```sh
node src/cli.ts /in/logic.json --out /out --template /template --snapshot-hash "$LOGIC_MODEL_HASH"
```

These are documented integration responsibilities only; no containers or runner code
were built. The test fixture tool versions label synthetic evidence, not actual tool
execution. Real conversion/validation report provenance/format still requires R7/R5
agreement. Until required evidence is supplied, ingestion remains blocked; do not move
conversion to another stage by weakening the gate without an agreed contract.

Hash mapping for later R6 integration (documentation only):

| Identity | Coverage / meaning |
| --- | --- |
| R2 logicModelHash = R5 manifest snapshotHash | Approved canonical envelope hash; manifest value is an echo, not an independent content check |
| R5 inputHash | Canonical bare LogicModel JSON; verify source/shared-fixture conformance before authoritative local recomputation |
| R5 artifactHash = R2 generatedFilesHash = future R6 compileArtifactHash | Sorted XLSX/properties file-list digest; does not cover later XML |
| R5 template.hash = R2 templateHash | Sorted template file-list digest excluding .gitkeep/.DS_Store; not a baseline |
| R7 packageHash = R2 packagedObject.sha256 / legacy workflow artifactHash | Actual project.tgz byte SHA-256; rebuilds need not yield identical archives |
| Future R6 testedDirHash | R6-computed complete tested directory identity including XML; not computed or substituted by R2 here |

The compilation job identity remains bound to request/model/approval, not the package
byte digest; differing tgz bytes must not silently create a new logical build. No
baselineHash is required. Baseline comparison and renamed-field detection remain future
work; templateHash and arbitrary prior builds are not baselines.

R6 VerificationReport v2.0.0 is agreed provisional but unpublished. R2 must later import
R6's **official exported JSON Schema** through its stable package export (exact export
path must be supplied by R6). Do not copy a schema or invent an import path now.
Validate every stored report with it, then independently bind echoed snapshotId,
logicModelHash, revision, clinicalApprovalId, compilationJobId and packageHash to trusted
records. Nullable echoes are not proof or permission; define required R2 bindings before
acceptance. Preserve both request and model revisions until R6 specifies revision's
meaning and an agreed snapshotId mapping. R6-computed compileArtifactHash and testedDirHash
are distinct from echoes and from package bytes. Require passed AND coverageComplete,
valid nonempty cases and outcome evidence under the official contract. Exit 0 requires
a valid passing report; exit 1 is a valid failed report; exit 2 has no valid report.
Until R4's evaluator/golden cases are ready, expected failures must stay failures.
Neither verification nor clinical approval replaces separate release approval.

No VERIFY_BUILD job, R6 report schema, verification ingestion or job dispatch is added.
The smallest Prompt 26 is a separate version-bound VERIFY_BUILD intent/outbox using the
accepted compilation record, after R7 confirms that job type and conversion boundary.
Bind package version/bytes, R5 file digest, manifest/template references, request/model,
clinical approval and compilation job/attempt. Keep R6 execution, authenticated schema-
validated report ingestion and independent release approval as separate guarded steps.

R4: publish shared contracts and evaluator/golden cases. R5: publish actual hash/manifest
implementation or shared conformance fixtures (including template and input hashing).
R6: publish schema v2.0.0 with a stable export and exact computed/echoed ID semantics.
R7: publish job status/hash mappings, artifact/build evidence format and conversion
ownership; implement verified S3 references, service identity and transactional attempt
conditions. All infrastructure remains pending; no root/shared package was modified.

Reconciliation validation: **1,076 passing tests** (all 1,057 prior cases + 19 focused
regressions), strict TypeScript zero errors and clean whitespace checks. Runtime:
Node v24.18.0; actual Node 22 execution and real AWS serialization remain untested.
All changes remain uncommitted; no push, merge or deployment occurred.
