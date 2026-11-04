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
