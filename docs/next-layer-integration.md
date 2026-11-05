# Intake → workflow integration contract

This document maps the endpoints and stored handoff that connect request intake to the next layer: the workflow orchestrator and AI drafter. It reflects the current code in `packages/intake/server.js`, `review.js`, `intake.js`, and `storage.js`.

For physical resource names, complete stored schemas, audit fields, and server-side retrieval examples, see [Request storage and downstream handoff](intake-storage-and-handoff.md).

**Current boundary:** the PO can submit, screen, preview, and confirm a revision. Confirmation saves a queued handoff in DynamoDB. There is no dispatcher, workflow-start endpoint, workflow-status endpoint, or running orchestrator implementation yet. The workflow endpoints below are a proposed contract to implement, not available routes.

## 1. Connection map

```mermaid
sequenceDiagram
    participant PO as PO browser
    participant Intake as Intake API
    participant DB as DynamoDB
    participant Worker as Handoff dispatcher (to build)
    participant Workflow as Orchestrator (to build)
    PO->>Intake: POST revision /screening
    PO->>Intake: POST revision /preview
    PO->>Intake: POST revision /confirmation
    Intake->>DB: Atomically store confirmation + queued snapshot
    Worker->>DB: Discover and claim queued handoff; recheck gates
    Worker->>Workflow: Proposed POST /internal/workflow-runs
    Workflow-->>Worker: Stable workflowId for revision
    Worker->>DB: Record dispatch receipt
    Worker->>Workflow: Proposed GET /internal/workflow-runs/by-revision/:revisionId
    Workflow-->>Worker: Workflow state
```

The browser calls the intake API. A trusted server-side dispatcher connects intake to the orchestrator. The browser must never invoke Bedrock or start the workflow directly.

## 2. Shared rules for implemented intake endpoints

- Use the intake server's origin. Local default: `http://127.0.0.1:3000`. A deployed origin is environment-specific.
- Send `Content-Type: application/json` for JSON requests. Responses are JSON with `Cache-Control: no-store`.
- All `/api` routes below except sign-in configuration and session exchange require `Authorization: Bearer <Cognito access token>` and a server-assigned PO role. Tokens are validated for signature, issuer, expiry, token use, and app client.
- Identity comes from the verified Cognito `sub`. Ownership is enforced using that identity. Another PO's request/revision returns `404`; these routes are not service-to-service APIs for the orchestrator.
- Request and revision path IDs are server-generated UUIDs. A request ID persists across corrections; each correction creates a new immutable revision ID.
- Application errors are currently JSON strings, for example `"Request not found."`, not `{ "error": ... }`. Handle both HTTP failure and domain failure states in a successful response.
- Success is currently `200` for every implemented route. A blocked submission or unsuccessful screening can still return `200`; inspect the returned status.

## 3. Implemented endpoint inventory

`R` means `/api/requests/:requestId/revisions/:revisionId` in the table below.

| Method | Endpoint | Caller / purpose | Request body | Successful response |
| --- | --- | --- | --- | --- |
| GET | `/api/sign-in` | Browser: discover Cognito sign-in settings | None | `{ hostedUrl, clientId, redirectUri }` |
| POST | `/api/session` | Browser: exchange authorization code after PKCE sign-in | `{ code, verifier }` | `{ token }` containing the access token |
| GET | `/api/profile` | Browser: retrieve verified author identity and recognized roles | None | `{ authorId, username, roles }` |
| GET | `/api/versions` | Browser: list permitted configuration baselines | None | Array of version strings |
| GET | `/api/requests` | Browser: load the signed-in PO's submissions | None | Array of immutable revision snapshots, including multiple revisions per request |
| POST | `/api/requests` | Browser: create a request and its first revision | Submission body below; `Idempotency-Key` header required | Immutable revision snapshot |
| GET | `/api/requests/:requestId` | Browser: revision history for one owned request | None | Array of immutable revision snapshots |
| POST | `/api/requests/:requestId` | Browser: correct an owned request | Same submission body; new `Idempotency-Key` | New immutable revision snapshot, retaining request ID |
| GET | `R` | Browser: retrieve exact owned revision | None | Immutable revision snapshot |
| GET | `R/screening` | Browser: retrieve current screening/review state | None | Review state below |
| POST | `R/screening` | Browser: start or explicitly repeat completeness screening | `{}` | Fresh Bedrock attempt; only an active attempt is reused. Confirmed revisions require a correction. |
| POST | `R/preview` | Browser: create or retrieve a screened revision's request preview | `{}` | Review state containing `preview` |
| POST | `R/rejection` | Browser: reject the current unconfirmed preview | Same preview binding as confirmation, with nonempty feedback | Review state with `rejection` |
| POST | `R/revise` | Browser: submit selected model edits as a correction | `{ attemptId, selections: [{ id, replacement, acceptAssumption? }] }`; `Idempotency-Key` required | New immutable revision snapshot |
| POST | `R/confirmation` | Browser: confirm the exact displayed preview and queue handoff | Confirmation body below | Review state with `confirmed: true`, `handoff: "queued"` |

Static assets (`/`, `/app.js`, `/styles.css`) are not workflow integration endpoints. There is no source-download API, standalone feedback API, handoff HTTP API, callback API, or workflow-status API in the current intake implementation.

### Submission body

```json
{
  "goal": "Add a follow-up task",
  "pathway": "Child cough",
  "targetUsers": "Community health workers",
  "acceptanceCriteria": "Show the approved follow-up task when the specified criteria apply",
  "baselineVersion": "v1",
  "guidelineUrls": ["https://example.org/public-guideline"],
  "attachment": {
    "name": "public-guideline.md",
    "base64": "<base64-encoded UTF-8 text>"
  }
}
```

The four requirement fields accept 1–4,000 characters after normalization. The baseline must resolve through the server registry. URLs are optional references, at most 20; the server does not fetch them. The attachment is optional for both submission and screening, supports UTF-8 TXT/Markdown, and has a 256 KiB limit. Bedrock assesses written requirements even without links or attachments. Evidence may cite the verified original submission source or an attached guideline source.

`Idempotency-Key` must contain 16–128 word or hyphen characters. Reuse the same key and exact submission bytes for a retry. Changed bytes or a different correction target under the same key return `409`. Keys are scoped to the authenticated author. A correction must resubmit all requirements and any attachment to retain in the new revision.

### Confirmation body

```json
{
  "previewId": "<preview.id from the latest review response>",
  "previewHash": "<preview.hash from the latest review response>",
  "attemptId": "<attemptId from the latest review response>",
  "feedback": "Reviewed the request summary."
}
```

`feedback` is required as a string; use `""` for no feedback. Maximum length: 4,000 characters. Extra fields are rejected. Repeating the same confirmation preserves the confirmation and handoff identities. Different feedback after confirmation returns `409`; corrections belong in a new revision.

### Review response

For an existing state under the current screening policy, the response contains:

| Field | Meaning |
| --- | --- |
| `status` | Current screening state; see gate table below |
| `enabled` | Whether screening is enabled on the server |
| `attemptId` | Identity of the authoritative screening attempt |
| `result` | Validated `{ decision, summary, issues, evidence, suggestions? }`, or `null` |
| `message` | Safe explanation, or `null` |
| `preview` | `{ id, hash, revisionId, attemptId, content }`, or `null` |
| `rejection` | `{ attemptId, previewId, previewHash, feedback, authorId, at }`, or `null` |
| `confirmed` | Whether this state has a recorded PO confirmation |
| `handoff` | `"queued"` when the handoff is stored; otherwise `null` |
| `retryable` | Whether a failed screening attempt is classified as a transient failure; explicit re-screening is available for any unconfirmed completed attempt |
| `leaseExpired` | Whether an active attempt's three-minute lease has expired |

An unscreened revision returns only `{ status: "pending_screening", enabled }`. A policy change returns a similar response with an explanatory message. A locally blocked revision returns `{ status: "blocked", enabled }`. Clients must tolerate omitted fields in those responses.

`result.suggestions` contains line-specific edits with `id`, `field`, `startLine`, `endLine`, `original`, `replacement`, `kind`, and `rationale`. `kind` distinguishes a clarification from an assumption. The current model response requires this array; older stored results can omit it.

`result.issues` contains `{ code, field, question }` entries. `result.evidence` contains `{ source, location }` entries referencing supplied source keys. Preview content is a deterministic summary containing `requirements`, `baselineVersion`, attachment `sources`, and screening `summary`. It is not generated clinical decision logic.

**Keep the two state sources distinct:** the immutable revision's `screeningStatus` remains its original local-validation status (`blocked` or `pending_screening`). Read `GET R/screening` for later screening, preview, and confirmation state. The queued downstream snapshot is separately enriched with `screeningStatus: "screening_passed"`.

### Failure handling

| HTTP status | Integration behavior |
| --- | --- |
| `400` | Invalid JSON, unsupported fields, invalid idempotency key, or invalid confirmation body; correct the request. |
| `401` | Missing/invalid/expired token or failed session exchange; sign in again. |
| `403` | Authenticated account lacks the PO role. |
| `404` | Missing or unowned request/revision, or unknown route. |
| `405` | Method is unsupported on a matched route. |
| `409` | Stale revision/preview, concurrent write, unmet gate, or conflicting idempotency payload; refresh before deciding whether to retry. |
| `413` | Submission body exceeds the transport cap (3,200 KiB). |
| `503` | Screening disabled or service/storage failure. For submission retries, retain the original key and payload. |

Submission JSON above 400 KiB but within the transport cap produces a blocked revision without storing the oversized body. Oversized review-action bodies are rejected. Bedrock operational failures normally appear as `screening_failed` inside a `200` review response; `retryable` identifies transient failures. Each explicit POST after completion starts a new attempt and clears any unconfirmed preview; it does not return a cached terminal result. An active attempt can return `screening`; refresh with GET rather than starting an unrelated submission. Confirmed revisions return `409` on re-screening and require a corrected revision.

## 4. Actual next-layer handoff: stored data, not an endpoint

Confirmation commits the following state in the intake DynamoDB table:

| Record | Partition key | Sort key | Use |
| --- | --- | --- | --- |
| Immutable revision | `requests#<authorId>` | `<requestId>#<revisionId>` | Original normalized request and source evidence under `snapshot` |
| Phase state | `author#<authorId>` | `phase#<requestId>#<revisionId>` | Current screening, preview, confirmation, and `outbox` |
| Current revision pointer | `author#<authorId>` | `head#<requestId>` | Authoritative current `revisionId` |
| Audit event | `author#<authorId>` | `event#<requestId>#<revisionId>#<eventId>` | Append-only screening/review evidence |

The phase record contains `outbox: { id: revisionId, status: "queued", snapshot: ... }`. There is no separate outbox table, queue, discovery index, or worker. Build discovery using a DynamoDB Stream or an explicitly designed queue/index; the current schema does not support a global query for all queued records. A stream handler must filter for newly queued work and remain safe under duplicate delivery.

### Queued snapshot fields the consumer must preserve

| Field | Required meaning |
| --- | --- |
| `requestId`, `revisionId`, `authorId` | Stable request, immutable revision, authenticated submitting author |
| `normalizedRequirements` | `goal`, `pathway`, `targetUsers`, `acceptanceCriteria` |
| `requirementsHash` | SHA-256 of `serializeRequirements(normalizedRequirements)` from `intake.js` |
| `baselineVersion`, `baselineHash` | Registry version and approved baseline artifact hash |
| `sources` | `{ bucket, key, versionId, sha256, filename? }` for original submission and accepted attachment |
| `references` | `{ url, source, versionId }` references linked to stored source evidence |
| `screeningStatus` | `"screening_passed"` in the enriched queued snapshot |
| `screening` | `{ attemptId, policy }`; `policy` is the screening configuration/prompt fingerprint |
| `preview` | `{ id, hash }` for the confirmed request preview |
| `confirmation` | `{ id, authorId, revisionId, previewId, previewHash, attemptId, feedback, at }` |
| `corrections`, `events` | Original intake-validation evidence; later review events are stored separately |

Raw attachment bytes and full documents are not embedded in this snapshot. The worker retrieves exact S3 versions using its IAM role and verifies SHA-256 before use. Do not fetch the latest object version or treat a reference URL as retrieved guideline content. The full screening result and preview content remain on the phase record; load them there if the drafter needs them.

## 5. Proposed orchestrator endpoints — to implement

These routes define the missing server-to-server connection. They must not be exposed as PO-authorized intake routes. Use a dedicated authenticated service identity and least-privilege access; select and implement its authentication mechanism when building the orchestrator.

### POST `/internal/workflow-runs`

**Caller:** the trusted handoff dispatcher. **Purpose:** accept a validated, confirmed revision exactly once at the workflow level.

Proposed headers: `Content-Type: application/json`, service authentication, and `Idempotency-Key: <revisionId>`. The receiving service must persist the key and a deterministic payload fingerprint before starting a run.

Proposed body:

```json
{
  "schemaVersion": 1,
  "handoffId": "<revisionId>",
  "snapshot": "<complete outbox.snapshot object described above>"
}
```

The `snapshot` value above denotes an object, not a serialized string. `schemaVersion` is a proposed transport-envelope field; it does not currently exist on the stored outbox.

Proposed first acceptance: `202` with `{ workflowId, requestId, revisionId, status: "accepted" }`. A retry with the same revision and payload must return the same `workflowId` (`200` or `202`), including after a timeout. Return `409` for the same key with a different payload, `422` for failed handoff validation, `401/403` for service-authentication failures, and `503` for temporary unavailability. Use a documented JSON error object for this new API rather than assuming the intake API's string errors.

The dispatcher must store the receipt without overwriting a concurrent phase-state update. Add durable dispatch state, claim/lease handling, and `workflowId` storage; none exists yet. A timeout after acceptance must be resolved by lookup or idempotent retry, not by creating a new handoff ID.

### GET `/internal/workflow-runs/by-revision/:revisionId`

**Caller:** the dispatcher/status synchronizer using its service identity. **Purpose:** recover an ambiguous start response and synchronize progress without launching another run.

Proposed `200` body: `{ workflowId, requestId, revisionId, status, updatedAt }`. Define workflow statuses as `accepted`, `running`, `awaiting_review`, `completed`, or `failed`; these are downstream workflow states, separate from intake screening states. Return `404` when the revision has no accepted workflow.

This proposal uses polling for reconciliation. A callback endpoint is not required for the initial connection and is not implemented. If callbacks are added later, define authentication, replay protection, event ordering, and duplicate handling before exposing one.

## 6. Gates the dispatcher and orchestrator must enforce

Read authoritative durable records before dispatch. The queued snapshot alone is insufficient: it can become stale after a correction or policy change.

| Gate | Required check |
| --- | --- |
| Local validation | Original revision has no local corrections and was accepted as `pending_screening`. |
| Current revision | `head#<requestId>.revisionId` equals the queued revision ID. |
| Current screening policy | Phase policy matches the active policy; phase status is `screening_passed`. |
| Evidence integrity | Requirements hash, baseline hash, and every source object version/hash match the revision. |
| Screening binding | Queued screening attempt/policy match authoritative phase state. |
| Preview binding | Stored preview ID/hash and its revision/attempt match the queued references; compare persisted hash bindings; resolve the [preview serialization limitation](intake-storage-and-handoff.md#5-complete-phase-schema) before independent hash recomputation. |
| PO confirmation | Confirmation actor and revision match the owned request; confirmation points to that exact preview and attempt. |
| Dispatch uniqueness | One accepted workflow ID per revision; retries preserve the same handoff ID and payload. |

`blocked`, `pending_screening`, `screening`, `needs_clarification`, `screening_blocked`, and `screening_failed` must never start downstream work. A screening pass without preview and confirmation must also stop. Keep clinical drafting, independent cross-check, human clinical approval, and release approval in their later stages.

The current PO routes enforce their own confirmation gates, but the future dispatcher must add these dispatch-time checks. Define the dispatch claim as the point of workflow acceptance and coordinate it with corrections/policy changes so a race cannot dispatch stale work. There is no cancellation endpoint or cancellation policy for already accepted workflows yet.

## 7. Connection checklist

1. Wire the implemented browser/API operations using the tables above. Obtain later review state from `/screening`, not the immutable revision's original status.
2. Select and test the live Bedrock model/guardrail in the sandbox; screening defaults to disabled.
3. Implement outbox discovery, durable claims, dispatch-time gate checks, and service authentication.
4. Implement the two proposed orchestrator routes, persistent revision-level deduplication, and workflow-ID lookup.
5. Store dispatch receipts and reconcile status. Add a separate authorized PO workflow-status read API only when progress needs to appear in the UI; none currently exists.
6. Test duplicate delivery, timeout after acceptance, expired worker lease, newer revision, changed screening policy, source-hash mismatch, unauthorized caller, and stale preview/confirmation. Each revision must produce at most one accepted workflow.

## 8. Source locations

- [HTTP routes and error encoding](../packages/intake/server.js)
- [Submission validation and immutable snapshot](../packages/intake/intake.js)
- [Screening, preview, confirmation, and queued handoff](../packages/intake/review.js)
- [DynamoDB keys and exact-version S3 access](../packages/intake/storage.js)
- [Bedrock integration and policy fingerprint](../packages/intake/screening.js)
- [Runtime configuration](../README.md#phase-two-screening-and-po-review)


## Targeted revisions after screening

The completeness prompt `intake-completeness-v4` (response schema 2) returns `suggestions` on both pass and clarification results. Each suggestion names a requirement field, an exact original range of 1-based lines, its replacement, rationale, and kind (`clarification` or `assumption`). Clarifications expand facts already supplied; additions involving new facts or policy are assumptions. Missing clinical policy is represented by an explicit author-completed placeholder rather than invented clinical guidance. The model's classification is a proposal for author review, not clinical approval.

The server validates exact original text, bounds, unique IDs, and non-overlapping ranges. Only the four requirement fields are editable this way. Baseline and evidence are preserved. Live model responses must include the suggestions array; older persisted results can still be read and manually corrected. The new prompt fingerprint requires fresh screening before old results can be used.

The browser no longer exposes the suggested-edit editor or a **Revise and submit** button. **Reject preview and revise** opens the same populated correction form as **Correct this request**, without calling the rejection or screening endpoints. Optional entered preview feedback appears in the correction notes; no feedback is required to navigate. Submitting that form uses the normal correction endpoint and creates a new revision requiring fresh screening.

The server's `rejection` and `revise` endpoints remain available for explicit API consumers. An API rejection requires feedback, records a durable rejection, and prevents confirmation of that preview. An API suggested revision requires selected edits and explicit assumption acceptance, preserves source evidence, and creates a new revision through normal intake. These API capabilities are separate from the current browser correction shortcut.
