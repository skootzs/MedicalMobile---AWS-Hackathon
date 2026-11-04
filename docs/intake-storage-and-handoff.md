# Request storage and downstream handoff

Implementation reference for the team connecting intake to the orchestrator and drafter. Verified against the local source on 2026-11-04. Resource names below are configured development values, not a verification of live AWS contents.

## Start here

After **Submit**, the canonical request revision is `snapshot` on a DynamoDB revision item. Original submission JSON and an optional attachment live in versioned S3.

After **Confirm this exact revision**, the downstream input is `outbox.snapshot` on the separate DynamoDB phase item. The same item holds the complete preview, screening result, and confirmation. The original revision item is unchanged.

**Confirmation currently means queued, not dispatched.** There is no separate outbox table, SQS queue, dispatcher, workflow run, or workflow ID. The next integration must discover queued phase items, validate their current bindings, and start one downstream workflow per revision.

Read this document for storage and complete field definitions. See [next-layer-integration.md](next-layer-integration.md) for HTTP contracts and proposed orchestrator endpoints.

## Complete synthetic storage example

[confirmed-intake-storage.json](examples/confirmed-intake-storage.json) contains a full successful submission and confirmation: revision item, head, completed retry reservation, confirmed phase with every populated success-path field, audit items, and original source bytes represented as UTF-8 text. Its nested outbox snapshot includes all submitted fields plus screening, preview, and confirmation bindings.

The example was generated through the actual `submit` and `createReview` functions with an in-memory adapter and a synthetic screening response. No AWS calls were made. The outer envelope and `sourceObjects` are documentation conveniences, not real table items. Failure-only and rejection-only fields are defined in sections 5 and 8 rather than added to an impossible combined success/failure record.

## 1. Physical locations and configuration

| Setting | Current development configuration | Purpose |
| --- | --- | --- |
| `AWS_REGION` | `us-west-2` | Region configured for the development runtime |
| `INTAKE_TABLE` | `medic-mobile-cht-intake-dev-7f4a2c` | Single DynamoDB table for revisions, phases, audit records, submission retry reservations, and roles |
| `INTAKE_BUCKET` | `medic-mobile-cht-intake-dev-7f4a2c` | Private, versioned S3 bucket containing original input bytes |
| `INTAKE_REGISTRY` | Absolute server-local JSON path, currently a temporary file | Mapping of configuration version names to SHA-256 baseline digests; no baseline artifact URI is stored in this registry |

Both resource names come from Terraform `var.intake_name`; the table and bucket are different AWS resources despite sharing a name. For another deployment, use that deployment's environment. Terraform exposes region/table/bucket through the `intake_environment` output. The current registry path is ephemeral and machine-specific: provision a durable registry and give the downstream process the same version-to-hash mapping. The actual baseline configuration artifact must be resolved separately by the next component.

Terraform configures the table with string keys `pk` and `sk`, on-demand billing, and point-in-time recovery. The bucket has public access blocked, AES256 server-side encryption, and versioning enabled. The current Terraform table definition has no secondary index or DynamoDB Stream enabled.

## 2. Write lifecycle

| Action | Persistent write | Returned to browser |
| --- | --- | --- |
| Submit a new request | Retry reservation; S3 original JSON and accepted attachment; immutable revision; current-revision pointer | Revision snapshot, including IDs and local-validation status |
| Submit a manual correction | Same records under a new revision ID and the existing request ID | New revision snapshot |
| Screen | Phase state plus append-only start/completion events | Public projection of phase state |
| Create preview | Full deterministic preview inside phase; preview-created event | Public phase state including full preview |
| Reject preview through API | Rejection inside phase; rejection event | Public phase state including rejection |
| Screen after rejection | New attempt replaces the phase's current attempt, result, preview, and rejection; historical events remain | Fresh public phase state |
| Submit selected suggested edits through API | Selection event on source revision; new normal submission records | New revision snapshot, pending screening when locally valid |
| Confirm | Confirmation and queued outbox written together with a confirmation event | Public phase state with `confirmed: true` and `handoff: "queued"` |

In the current browser, **Reject preview and revise** is a shortcut to the existing correction form. It does not write a rejection or start another screening attempt; optional feedback is carried into the correction notes. No storage changes occur until the corrected form is submitted. The API rejection and suggested-revision operations above remain implemented for explicit API consumers.

S3 writes precede the transaction that finishes submission. Failed attempts can leave source objects or reservations without a completed revision; source-object presence alone is not evidence of accepted intake. Submission completion atomically stores the reservation's result, revision, and head pointer. Phase updates atomically check their state version and append the audit event. Preview, rejection, and confirmation additionally check the current revision head. Suggested-revision completion checks the head and screening-state version in its transaction.

Each correction retains `requestId` and creates a new `revisionId`. Suggested corrections copy the original accepted attachment into a new source object, preserving its bytes/hash but changing its source key/version. Manual corrections include only attachments resubmitted by the author.

## 3. DynamoDB item catalog

Angle-bracket values are substitutions, not literal text. `authorId` is the verified Cognito `sub`.

| Item | `pk` | `sk` | All non-key top-level fields |
| --- | --- | --- | --- |
| Immutable revision | `requests#<authorId>` | `<requestId>#<revisionId>` | `snapshot` |
| Current phase | `author#<authorId>` | `phase#<requestId>#<revisionId>` | `version`, `status`, `attemptId`, `policy`, `leaseUntil`; conditional `result`, `requestId`, `usage`, `retryable`, `failureCode`, `message`, `preview`, `rejection`, `confirmation`, `outbox` |
| Current revision pointer | `author#<authorId>` | `head#<requestId>` | `revisionId` |
| Review audit event | `author#<authorId>` | `event#<requestId>#<revisionId>#<eventId>` | `type`, `at`, plus event-specific fields in section 8 |
| Submission retry reservation | `author#<authorId>` | `key#<Idempotency-Key>` | `fingerprint`, `requestId`, `revisionId`, `receivedAt`, `baselineHash`; `result` after completion |
| Role assignment | `roles#<authorId>` | `assignment` | `roles` (array of role strings) |

Phase, head, and review audit items do not have a separate top-level application `authorId` or application `requestId` field; recover them from the key or the nested snapshot. **The optional phase-level `requestId` is the Bedrock AWS request ID, not the application's request ID.**

The phase item may not exist until screening starts. The head is written on new submissions; older records can acquire it when a current-revision gate initializes the pointer. The role source is administered separately; the intake service does not create role assignments.

## 4. Complete submitted revision schema

The stored item is `{ pk, sk, snapshot }`. The submit and revision-read APIs return `snapshot` directly, without the DynamoDB wrapper.

```ts
type Requirements = {
  goal: string;
  pathway: string;              // UI: Affected pathway
  targetUsers: string;
  acceptanceCriteria: string;
};

type SourceVersion = {
  bucket: string;
  key: string;
  versionId: string;            // Exact S3 VersionId
  sha256: string;               // Lowercase SHA-256 of raw object bytes
  filename?: string;            // Present only for accepted attachment
};

type Reference = {
  url: string;
  source: string;               // S3 object key, not a source-array index
  versionId: string;            // Version of the object containing this link
};

type SubmittedRevision = {
  requestId: string;            // UUID, stable across corrections
  revisionId: string;           // UUID, new for every correction
  authorId: string;             // Cognito sub from server authentication
  normalizedRequirements: Requirements;
  requirementsHash: string;
  baselineVersion: string;
  baselineHash: string | null;
  sources: SourceVersion[];
  references: Reference[];
  screeningStatus: 'blocked' | 'pending_screening';
  corrections: string[];       // Local validation messages, empty on success
  events: { status: 'received' | 'blocked' | 'pending_screening'; at: string }[];
};
```

`events` initially contains two entries: received and the local-validation outcome. Their timestamps are ISO 8601 strings. Later screening/review activity does not append to this array: it goes to separate audit items.

The four text fields are normalized to NFC, trimmed, and converted from CRLF/CR to LF. Each requires 1–4,000 characters. Invalid required text fields become empty strings on the blocked snapshot. The baseline is trimmed, resolved through the registry, and stored with that registry digest; an unknown baseline has a null digest and blocks intake. A baseline name longer than 256 characters is stored as an empty string.

`requirementsHash` is SHA-256 over UTF-8 JSON returned by `serializeRequirements` in `packages/intake/intake.js`: the four keys appear in the exact order `goal`, `pathway`, `targetUsers`, `acceptanceCriteria`. It is not the hash of the raw submission, S3 metadata, or a reformatted JSON object.

The immutable `screeningStatus` stays `pending_screening` even after later screening and confirmation. It is a local-validation result, not current workflow state.

### Original S3 objects

| Object key | Content |
| --- | --- |
| `intake/<revisionId>/submission.json` | Original request-body bytes, including optional base64 attachment if submitted |
| `intake/<revisionId>/attachment` | Decoded, validated UTF-8 TXT/Markdown bytes; original filename is in `SourceVersion.filename` |

Original submission JSON accepts exactly these fields: `goal`, `pathway`, `targetUsers`, `acceptanceCriteria`, `baselineVersion`, optional `guidelineUrls: string[]`, optional `attachment: { name: string, base64: string }`. Identity, roles, and confirmation are never accepted in that body. The raw body is preserved, not reconstructed from normalized values.

An accepted attachment is at most 256 KiB. URLs supplied in the form or extracted from an attachment become references linked to the object key and version that contained them. URLs are not fetched. There is no extracted-document store or source-download HTTP endpoint. A source with `filename` supplies guideline text; the submission source supplies written requirements evidence.

Submissions above the 400 KiB JSON buffer but within the 3,200 KiB transport cap produce a blocked snapshot without storing the oversized original body. Its source list is empty. Some malformed requests fail before any revision is created. Never assume a blocked revision has a submission source or attachment.

### Retry reservation

`fingerprint` is `hash(JSON.stringify([requestId ?? null, hash(rawBodyBytes)]))` for normal submissions. Oversized submissions use the streaming body digest in place of `hash(rawBodyBytes)`. `receivedAt` is the reservation timestamp; `baselineHash` is fixed at reservation. `result`, when present, contains the entire `SubmittedRevision`. The reservation is a retry record, not a downstream queue. Idempotency keys are author-scoped, 16–128 word/hyphen characters; changed bytes or targets under the same key conflict.

## 5. Complete phase schema

Stored phase reads include the DynamoDB key wrapper. Fields marked optional are absent unless that operation has populated them; they are not necessarily stored as null.

```ts
type ScreeningResult = {
  decision: 'pass' | 'needs_clarification';
  summary: string;
  issues: { code: string; field: keyof Requirements | 'baselineVersion' | 'guideline'; question: string }[];
  evidence: { source: string; location: string }[];
  suggestions?: Suggestion[];   // Required on current live model responses; optional on older records
};

type Suggestion = {
  id: string;
  field: keyof Requirements;
  startLine: number;            // Inclusive, 1-based within normalized field
  endLine: number;              // Inclusive
  original: string;             // Exact original line range, joined with LF
  replacement: string;
  kind: 'clarification' | 'assumption';
  rationale: string;
};

type Preview = {
  id: string;
  hash: string;
  revisionId: string;
  attemptId: string;
  content: {
    requirements: Requirements;
    baselineVersion: string;
    sources: SourceVersion[];   // Attachment sources only
    summary: string;            // Screening summary, not generated clinical logic
  };
};

type Confirmation = {
  id: string;
  authorId: string;
  revisionId: string;
  previewId: string;
  previewHash: string;
  attemptId: string;
  feedback: string;             // May be empty; maximum 4,000 characters
  at: string;                   // ISO timestamp
};

type Rejection = {
  attemptId: string;
  previewId: string;
  previewHash: string;
  feedback: string;             // Nonempty, maximum 4,000 characters
  authorId: string;
  at: string;
};

type PhaseItem = {
  pk: string;
  sk: string;
  version: number;              // Incremented on every phase write; concurrency control
  status: 'screening' | 'screening_passed' | 'needs_clarification' |
          'screening_blocked' | 'screening_failed';
  attemptId: string;
  policy: string;               // Screening configuration/prompt fingerprint
  leaseUntil: number;          // Epoch milliseconds; zero after completion
  result?: ScreeningResult;
  requestId?: string | null;    // Bedrock AWS request ID; NOT application requestId
  usage?: { inputTokens: number; outputTokens: number } | null;
  retryable?: boolean;
  failureCode?: string;
  message?: string;
  preview?: Preview;
  rejection?: Rejection;
  confirmation?: Confirmation;
  outbox?: {
    id: string;                // Same as revisionId
    status: 'queued';
    snapshot: ConfirmedSnapshot;
  };
};
```

`pending_screening` and `blocked` are public synthesized states, not newly stored phase statuses. A successful attempt stores `result`, AWS `requestId` (or null), and `usage` (or null). A failed/blocked attempt stores `retryable`, `failureCode`, and safe `message`, without a successful result. Guardrail/source-integrity/input-size failures are blocked. Model/configuration/response failures are failed; only designated transient exceptions set `retryable: true`.

`policy` is a hash string on the phase. The full configuration is recorded in the corresponding `screening_started` audit event (section 8). The fingerprint includes enabled flag, region, selected model, guardrail settings, prompt/schema versions, runtime limits, and the prompt text. Consumers need the same active policy fingerprint; a matching version label alone is insufficient.

The current preview hash is `hash(JSON.stringify(content))` at creation, not a canonical JSON format or clinical-logic hash. Map-key ordering is not a portable cross-language contract, and raw serialized preview bytes are not saved separately. Compare the stored preview/confirmation/outbox hashes for binding. Before adding independent preview-hash recomputation across storage readers or languages, establish canonical serialization and migrate/version that contract; arbitrary reserialization of a DynamoDB map may produce a different digest.

### Browser review projection

`GET /api/requests/<requestId>/revisions/<revisionId>/screening` returns `status`, `enabled`, `attemptId`, `result`, `message`, `preview`, `rejection`, `confirmed`, `handoff`, `retryable`, `leaseExpired` for an existing current-policy state. Missing `result`, `message`, `preview`, and `rejection` are returned as null; `confirmed` and `handoff` are derived from the existence of confirmation/outbox, not persisted fields with those names.

When no phase exists, the API returns just `{ status: "pending_screening", enabled }`; local blockage returns `{ status: "blocked", enabled }`; policy mismatch returns a pending state plus a message. The public API does not expose the complete confirmation, phase version, policy fingerprint, AWS request ID, usage, or queued snapshot. Downstream workers use IAM-authorized storage access, not this projection or a PO browser token.

## 6. Complete confirmed handoff schema

`ConfirmedSnapshot` contains every submitted revision field, with `screeningStatus` replaced and three additions:

```ts
type ConfirmedSnapshot = Omit<SubmittedRevision, 'screeningStatus'> & {
  screeningStatus: 'screening_passed';
  screening: { attemptId: string; policy: string };
  preview: { id: string; hash: string };
  confirmation: Confirmation;
};
```

Thus the complete top-level field list is:

```text
requestId, revisionId, authorId,
normalizedRequirements, requirementsHash,
baselineVersion, baselineHash,
sources, references,
screeningStatus, corrections, events,
screening, preview, confirmation
```

The outbox wraps it as `{ id: revisionId, status: "queued", snapshot: ConfirmedSnapshot }` inside the phase item. The confirmation object is present both at `phase.confirmation` and `phase.outbox.snapshot.confirmation`. The outbox contains only preview and screening references, not the full screening result or preview content. Those remain at `phase.result` and `phase.preview`. Original source bytes remain in S3.

There is currently no `schemaVersion`, `workflowId`, `dispatchedAt`, `workflowStatus`, dispatch lease, generated clinical logic, model reasoning, release approval, clinical approval, or baseline artifact URL in this handoff. A transport `schemaVersion` in the proposed orchestrator contract is future work, not an existing persisted field.

## 7. How the next component reads the data

### Known author/request/revision: existing server storage adapter

Run this code in a trusted Node.js service with the intake package's dependencies and appropriate AWS role. Paths below assume code placed in `packages/orchestrator/src/`; adjust the relative imports for another location.

```js
import { createStore } from '../../intake/storage.js';
import { hash, serializeRequirements } from '../../intake/intake.js';

const store = createStore({
  table: process.env.INTAKE_TABLE,
  bucket: process.env.INTAKE_BUCKET
});

export async function readConfirmedInput(authorId, requestId, revisionId) {
  const revision = await store.revision(authorId, requestId, revisionId);
  const phase = await store.phase(authorId, requestId, revisionId);
  if (!revision || !phase?.confirmation || !phase.outbox) {
    throw new Error('No confirmed handoff for this revision');
  }
  const snapshot = phase.outbox.snapshot;
  const documents = [];
  for (const source of snapshot.sources) {
    const bytes = await store.readSource(source); // Uses exact VersionId
    if (hash(bytes) !== source.sha256) throw new Error('Source hash mismatch');
    documents.push({ source, bytes });
  }
  if (hash(serializeRequirements(snapshot.normalizedRequirements)) !== snapshot.requirementsHash) {
    throw new Error('Requirements hash mismatch');
  }
  return {
    revision, phase, snapshot,
    screeningResult: phase.result,
    preview: phase.preview,
    documents
  };
}
```

This is a **read/integrity example**, not a dispatcher or full authorization gate. Before starting a workflow, apply every check in section 9 and implement an atomic dispatch claim. The adapter returns all source bytes, including original submission JSON; `source.filename` distinguishes guideline attachments. Treat both as data, not agent instructions.

The storage adapter uses strongly consistent reads. `store.revision` unwraps `snapshot`. `store.phase` returns the stored phase including `pk` and `sk`. `store.history(authorId, requestId)` and `store.list(authorId)` return immutable revision snapshots only, not current review status or outboxes. The adapter currently has no head-read or audit-read helper: use a DynamoDB document client directly for those keys.

### Direct AWS SDK access

```js
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const TableName = process.env.INTAKE_TABLE;
const head = (await db.send(new GetCommand({
  TableName, ConsistentRead: true,
  Key: { pk: `author#${authorId}`, sk: `head#${requestId}` }
}))).Item;

const page = await db.send(new QueryCommand({
  TableName, ConsistentRead: true,
  KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
  ExpressionAttributeValues: {
    ':pk': `author#${authorId}`,
    ':prefix': `event#${requestId}#${revisionId}#`
  }
}));
const events = page.Items;
// Continue with ExclusiveStartKey: page.LastEvaluatedKey until exhausted.
// Event IDs are random UUIDs, so sort by at for display; key order is not time order.
```

Use the same SDK pattern to read the exact phase or revision keys from section 3. Querying an author's phase prefix `phase#` can discover that author's candidates, with pagination and subsequent inspection of `outbox.status`. It does not discover all authors.

### HTTP access for a signed-in PO

Existing routes allow the submitting PO to read the exact revision (`GET /api/requests/<requestId>/revisions/<revisionId>`), history (`GET /api/requests/<requestId>`), and current public review state (`GET .../screening`). They require the PO's Cognito access token and server-managed PO role and enforce ownership. There is no HTTP endpoint exposing raw S3 bytes, full internal phase records, or outbox payloads to an orchestrator.

### Discovery and required AWS access

A known-ID consumer can read immediately using the keys above. Automatic discovery of all queued handoffs remains to be built. The current table supports neither a global queued-work query nor a configured Stream. Choose a DynamoDB Stream handler, a queue, or an index-backed outbox design; each requires infrastructure and retry/claim semantics. A table scan is a possible explicitly authorized development inspection, not the existing runtime integration, and the current runtime policy does not grant Scan.

Use a dedicated downstream IAM role. Known-ID retrieval requires `dynamodb:GetItem`, optional `dynamodb:Query` for history/events, and `s3:GetObjectVersion` for the specific intake bucket's `intake/*` objects. The source adapter validates bucket/key/version and uses `GetObject` with `VersionId`. Dispatcher writes, Stream discovery, queue access, and baseline-artifact access require separately scoped permissions. Sharing a PO's bearer token is not the service integration.

## 8. Audit fields and suggestion provenance

Every audit item has `pk`, `sk`, `type`, and `at`. `at` is generated by storage as an ISO timestamp. Event type determines the remaining fields:

| `type` | All additional fields |
| --- | --- |
| `screening_started` | `attemptId`, `policy` (full configuration object below) |
| `screening_completed` on success | `attemptId`, `status`, `result`, `requestId` (AWS ID or null), `usage` (object or null), `evidenceBinding` |
| `screening_completed` on blockage/failure | `attemptId`, `status`, `retryable`, `failureCode`, `message`, `evidenceBinding` |
| `preview_created` | `preview` (complete `Preview`) |
| `preview_rejected` | `rejection` (complete `Rejection`) |
| `revision_suggestions_selected` | `attemptId`, `selections`, `rejectedPreviewId` (string or null) |
| `confirmed` | `confirmation` (complete `Confirmation`) |

`evidenceBinding` is `{ requirementsHash, baselineHash, sources }`, copied from the exact revision. It does not contain the full request text.

The full policy object on `screening_started` contains `enabled`, `region`, `modelId`, `guardrailIdentifier`, `guardrailVersion`, `promptVersion`, `schemaVersion`, `timeoutMs`, `maxInputBytes`, `maxTokens`, and `fingerprint`. Current code defaults are prompt version `intake-completeness-v4`, response schema 2, timeout 20,000 ms, max input 12,000 bytes, and output 4,096 tokens. Environment overrides change the fingerprint. The prompt text itself is in source code, not copied into the event; the fingerprint includes it.

Each selected edit is `{ id, replacement, acceptAssumption? }`. `acceptAssumption: true` is required for an assumption; a caller may send `false` for a clarification. The browser no longer submits suggested edits directly. The event records user-edited replacement text, not just the original model proposal. Join the event's `attemptId` with the corresponding screening-completed event's `result.suggestions` IDs to recover kind, rationale, source field, and original lines. A model's kind classification and author acceptance do not constitute clinical approval.

Selection is audited **before** the new revision is committed. The event alone therefore does not prove that the correction succeeded. There is no explicit `parentRevisionId`, `selectedFromAttemptId`, or new-revision ID on the selection event/new snapshot. A durable parent-to-child revision link is an integration extension if the next step needs direct ancestry queries. The retry reservation identifies the resulting revision when its idempotency key is known.

Re-screening replaces current phase state, while audit events preserve earlier results, previews, and rejection feedback. Repeated confirmation retains the same confirmation/outbox identities but may append another confirmation event. Audit consumers must tolerate repeated events for the same logical confirmation. Event `at` is not guaranteed to be a unique ordering key for simultaneous writes.

## 9. Dispatch validation and remaining integration work

A downstream start requires all of the following from trusted durable records:

1. The original revision belongs to the expected author/request/revision, has no corrections, and has local status `pending_screening`.
2. The authoritative head item still points to that revision. A queued handoff from an older corrected revision is stale.
3. Phase status is `screening_passed`, `phase.policy` matches the active policy fingerprint, and the result is a validated pass.
4. The outbox is queued for this revision. Its normalized request, source references, baseline, author, and hashes match the immutable revision.
5. The queued screening attempt/policy equal the current phase attempt/policy.
6. Full preview revision/attempt and preview ID/hash match the outbox references and confirmation. The phase has no current rejection.
7. Confirmation author/revision/attempt and preview ID/hash match those same records; phase confirmation equals the queued confirmation.
8. Requirements, exact S3 source bytes/versions, and baseline digest pass integrity checks against the same revision and approved registry. URL references alone are not retrieved clinical evidence. Address the preview serialization limitation in section 5 before independently recomputing that hash.
9. A durable dispatch claim coordinated with revision/policy changes prevents a stale-read race. The orchestrator deduplicates persistently by revision ID and returns the same workflow ID on retry.

The current consumer-facing payload should be `phase.outbox.snapshot`, accompanied by the exact phase screening result, preview content, and verified source bytes only when needed by the drafter. Preserve provenance and hashes; do not rebuild requirements from a displayed preview or browser assertion.

The orchestrator/drafter entry points (`packages/orchestrator/src/server.ts`, `routes/submit.ts`, `snapshots.ts`, `storage/requests.ts`, `workflow.ts`, and `packages/drafter/src/index.ts`) are currently empty scaffolds. The next implementation needs discovery, service authentication, a dispatcher claim/lease, dispatch-time validation, durable deduplication, workflow start, workflow-ID receipts, and status reconciliation. None of those fields or endpoints is implied by a queued outbox.

[The proposed workflow endpoints](next-layer-integration.md#5-proposed-orchestrator-endpoints--to-implement) define the planned server-to-server boundary. Clinical drafting, independent cross-check, clinician approval, and release approval follow later; intake completeness and PO confirmation approve only the request snapshot.

## Source map

| Concern | Implementation |
| --- | --- |
| Submission normalization, source keys, snapshot, retry fingerprint | [intake.js](../packages/intake/intake.js) |
| DynamoDB keys, transactions, versioned S3 reads | [storage.js](../packages/intake/storage.js) |
| Screening, preview, rejection, selected edits, confirmation/outbox | [review.js](../packages/intake/review.js) |
| Screening result schema, model adapter, policy fingerprint | [screening.js](../packages/intake/screening.js) |
| Suggestion validation and exact line application | [suggestions.js](../packages/intake/suggestions.js) |
| HTTP access and startup configuration | [server.js](../packages/intake/server.js) |
| Table/bucket definitions and environment output | [dynamodb.tf](../infra/terraform/dynamodb.tf), [s3.tf](../infra/terraform/s3.tf), [outputs.tf](../infra/terraform/outputs.tf) |
| Existing runtime permissions | [iam.tf](../infra/terraform/iam.tf) |
