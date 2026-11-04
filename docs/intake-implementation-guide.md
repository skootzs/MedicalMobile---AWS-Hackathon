# Intake implementation guide

Build phase one in `packages/ui` and `packages/intake`. Get a PO from sign-in to a traceable request revision before starting the phase-two preview and review flow.

## Phase one — Sign-in and request intake

### 1. Find the existing entry points

Locate the app’s routing, API authentication middleware, database migrations, AWS configuration, and configuration-version registry. Use `packages/ui` for the screens and `packages/intake` for intake validation, persistence, and the handoff contract. Reuse the app’s existing patterns for routes, storage, and errors.

### 2. Add Cognito sign-in and protect the intake API

Connect the sign-in screen to Cognito. On every protected API route, validate the access token’s signature, issuer, expiration, token type, and app client. Use the verified `sub` as the author ID. Return `401` when the token is missing or invalid.

Look up roles using the app’s server-managed role source. Recognize PO, service designer, developer, clinician, and release approver. Allow only POs to create requests and read their own requests and revision histories in phase one. Apply ownership checks to request lists, individual requests, and revision lookups. Reject client-supplied author, actor, and role fields.

**Verify** that a PO can sign in, invalid credentials fail, a signed-in user without the PO role is denied, and two POs cannot read each other’s requests. Submit forged attribution fields and check that the API rejects them.

### 3. Define the request and revision records

Give each request a stable request ID. Give each submission or correction a new immutable revision ID. Store the authenticated author, normalized requirements, baseline version and hash, and source metadata against the revision. Use append-only status events to capture when a revision was received, blocked, or marked `pending_screening`.

Resolve the submitted configuration version through the server’s configuration registry. Block unknown versions. Define one deterministic serialization for the normalized requirements and use it to compute their SHA-256 hash.

### 4. Build the PO request screen

Add plain-text fields for the goal, affected pathway, target users, and acceptance criteria. Add a current configuration version field and inputs for public clinical guideline URLs or attachments. Show the configured attachment formats and size limit beside the upload control.

Generate an idempotency key for each new submission attempt and reuse that key on retries of the same payload. Render a request detail view with the revision ID, status history, and any correction needed. Submitting a correction should keep the request ID and create a new revision.

### 5. Validate inputs and preserve source evidence

Validate required fields and the baseline version on the server. Enforce the upload size limit before parsing. Check that each attachment matches a supported format and handle parser failures explicitly. Store submitted guideline URLs as references without fetching them in phase one.

Store the original submission and accepted attachments in private, versioned S3 storage. Record the S3 object version and SHA-256 hash for each stored source. Link extracted guideline references back to the source version they came from. Treat submitted and extracted text as data throughout, including text that contains instructions.

Record a blocked status and a clear correction message for failed checks. Keep raw parser errors out of the UI and render any displayed source text as plain text. Mark locally valid revisions `pending_screening`. Both statuses must stop at the intake boundary.

### 6. Make retries safe

Enforce uniqueness for the combination of authenticated author and idempotency key in persistent storage. Reserve the key before writing source objects so concurrent retries cannot each create a revision. Associate the key with a fingerprint of the submitted payload.

Return the original request and revision IDs for the same key and payload. Return a conflict for the same key with a different payload. Make a failed attempt recoverable under the same key so a partial write can be retried without creating another revision.

### 7. Prepare the `RequestSnapshot` handoff

Define a `RequestSnapshot` that carries the request ID, immutable revision ID, authenticated author ID, version-specific source references and hashes, normalized requirements and their hash, baseline configuration version and hash, and screening status. Keep raw submissions, attachment bytes, and full extracted documents in source storage.

Prepare the snapshot in phase one and enforce the handoff gate at the point where downstream work would start. Exercise a blocked screening result with a test double. Defer the Bedrock integration and model guardrails to phase two.

### 8. Run the phase-one acceptance checks

- Test missing, expired, and invalid access tokens alongside the sign-in and ownership cases from step 2.
- Submit missing fields, an unknown baseline version, unsupported and malformed documents, an oversized upload, and a document that triggers a parser failure. Check the blocked status and correction message for each.
- Use a public test fixture containing embedded prompt instructions. Verify that its text is preserved as data and has no effect on permissions or workflow state. Verify that both pending screening and a simulated blocked screening result prevent downstream work.
- Retrieve the stored version of each source, recompute its hash, and trace the extracted references, normalized requirements, and baseline hash to the same revision.
- Submit the same request twice, then repeat with concurrent submissions. Confirm one revision and the same returned IDs. Change the payload under the same key and check for a conflict. Confirm zero workflow runs for blocked or pending revisions.

## Phase two — Bedrock screening, preview, and PO review

This section is an implementation plan. Phase one currently stops at `pending_screening`; the steps below add the Bedrock integration and subsequent review gates. Screening determines whether requirements are complete enough to preview. It does not certify clinical correctness, scan files for malware, approve a release, or replace the independent cross-check of drafted clinical logic.

### 9. Configure Bedrock and the screening boundary

Implement a server-side screening adapter in `packages/intake`, with a separate prompt and response schema. Extend `infra/terraform` for the guardrail, published guardrail version, and runtime permissions. Use the AWS SDK for JavaScript v3 Bedrock Runtime client and non-streaming Converse calls. Keep AWS credentials and model access on the server through its IAM role.

Add server configuration for the AWS Region (sandbox default `us-west-2`), model or inference-profile ID, guardrail ID and numeric version, prompt version, request timeout, maximum input size, and output token limit. Select and record a model available in the sandbox after testing completeness screening on representative fixtures. Do not hard-code an assumed model ID. Confirm any inference profile's destination Regions satisfy the environment's data-location requirements before enabling it.

Grant only the required model invocation and guardrail application permissions for the selected resources. Include destination model resources if an inference profile requires them. Keep guardrail administration in the provisioning role. Fail startup when enabled screening lacks required configuration; provide an explicit disabled mode that leaves requests pending. Never silently substitute a mock or unguarded call in a deployed environment.

**Verify** a real call from the runtime role, a denied call to an unapproved model, and a missing or invalid guardrail configuration. Record the selected model, Region, guardrail version, and deployment settings in the README without credentials.

### 10. Load and verify the exact revision

Start screening only after the revision and its source objects have been durably stored. Reuse the existing authentication and ownership checks for any PO-triggered screening or retry route. Load author, requirements, baseline, and source references from the stored revision rather than trusting browser-supplied values.

Retrieve each required attachment by its recorded S3 object version, recompute SHA-256, and compare it with the revision's source hash. Recompute the normalized requirements hash using phase one's deterministic serialization. Fail closed on missing objects, mismatched hashes, or a baseline that cannot be resolved.

Keep the current UTF-8 TXT/Markdown attachment support and 256 KiB upload limit. Add a separate total screening input limit sized for the chosen model. Do not silently truncate sources or infer facts from omitted material. Ask for a smaller scoped guideline when the screening input cannot fit. Preserve original bytes and source references unchanged.

URL references remain references unless a separate controlled retrieval feature is implemented. Do not let the model fetch arbitrary URLs. When guideline content is necessary to assess completeness but only an unread URL is available, request an attachment or supplied public excerpt and leave the revision unpassed.

### 11. Apply guardrails and request structured screening

Configure sensitive-information filtering and prompt-attack protection against public and synthetic fixtures. Check raw submitted requirements and guideline text with the configured guardrail before inference. Attach the same published guardrail through Converse's `guardrailConfig` for the model call and handle guardrail intervention explicitly. Configure and test the appropriate content qualifiers for prompt-attack evaluation. A guardrail intervention stops processing; an API failure never counts as a pass.

Keep the fixed screening instructions in the system prompt and submitted requirements and guideline excerpts in clearly identified data blocks. Instruct the model to identify missing information, avoid inventing clinical criteria, and treat embedded instructions as source text. Give the screening call no tools or authority to change roles, approve revisions, fetch URLs, or start workflows. Guardrails supplement these application controls and cannot guarantee detection of every attack or every instance of personal data.

Define a versioned JSON response schema containing:

- `decision`: `pass` or `needs_clarification`.
- `summary`: a short completeness explanation.
- `issues`: bounded entries with a stable code, affected field, plain-text question, and optional source reference.
- `evidence`: references to supplied source IDs and locations supporting the assessment.

Ask whether the goal, pathway, intended users, acceptance criteria, baseline, and necessary guideline evidence are sufficiently specific and mutually consistent. Require clarification for ambiguity; never fill in missing clinical intent. Treat all returned text and references as untrusted. Validate JSON, enums, string lengths, reference membership, and consistency (a pass cannot contain unresolved issues). Reject extra authority-bearing fields. Malformed, truncated, empty, or guardrail-blocked output cannot become a pass.

### 12. Persist screening attempts and make retries safe

Keep immutable revision contents unchanged. Store append-only screening attempts and status events tied to the request ID, revision ID, requirements hash, baseline hash, source versions and hashes, model ID, prompt version, response-schema version, and guardrail version. Give each attempt an ID and record start/end times, decision or failure code, validated findings, AWS request ID when available, and token usage when returned. Keep raw content out of ordinary logs.

Use these proposed screening states separately from the existing local-validation result:

| State | Meaning and allowed action |
| --- | --- |
| `pending_screening` | Not assessed; no preview or downstream handoff. |
| `screening` | An attempt holds a time-limited persistent lease; no handoff. |
| `needs_clarification` | PO must submit a corrected revision. |
| `screening_blocked` | Guardrail or source-integrity check stopped processing; no handoff. |
| `screening_failed` | Operational or invalid-response failure; controlled retry is allowed. |
| `screening_passed` | Completeness passed for this exact evidence and policy version; preview is allowed. |

Claim work with a conditional DynamoDB write keyed by revision and screening-policy fingerprint so concurrent requests cannot launch duplicate active attempts. Persist a lease expiry and attempt identity. Accept completion only from the current lease holder; late responses cannot overwrite newer results. Reuse a completed result for the same revision and policy. A policy change creates a new screening generation and invalidates any preview and confirmation based on the old result.

Use bounded retries with backoff and jitter for throttling, transient service errors, and timeouts. Avoid multiplying SDK retries with application retries. Do not retry access-denied, invalid configuration, guardrail interventions, or clarification decisions automatically. After a crash, recover an expired lease without allowing two committed results. Bedrock calls may repeat after an ambiguous timeout; guarantee idempotent persisted results, not exactly one billed inference call.

### 13. Add clarification, preview, and confirmation

In `packages/ui`, show screening progress, plain-language correction questions, and a safe retry action for operational failures. Render returned text as plain text. Keep internal errors and guardrail traces out of the browser. A corrected submission keeps the request ID, creates a new revision, and runs screening again. Never carry forward a prior revision's pass or confirmation.

Generate a preview only after a validated screening pass. Bind its stored artifact ID and hash to the exact revision and screening attempt. If preview generation uses Bedrock, use a separate versioned prompt, guardrailed call, and validated response schema; it does not inherit authority from the screening call. A failed preview remains unconfirmable.

Record feedback and explicit PO confirmation with the authenticated actor, revision ID, screening attempt ID, preview ID/hash, and timestamp. Recheck ownership and these bindings on the server. Corrections or a new preview invalidate earlier confirmation. Reject stale confirmations rather than silently applying them to the current revision.

### 14. Connect the orchestrator and AI drafter

Extend the `RequestSnapshot` with the validated screening-result reference and policy versions, preview reference/hash, and confirmation reference. Pass version-specific source references and hashes; retrieve full source content only in the component that needs it.

At the handoff boundary, load durable records and require local validation success, a current screening pass, a matching preview, and explicit confirmation for that same revision. Never accept a browser or model assertion of these gates. Reject pending, failed, blocked, clarification-required, and stale records.

Persist an idempotent handoff record or outbox entry with a unique key per revision before dispatch. Have the orchestrator honor the same key so a crash after dispatch cannot start a second workflow. Retry delivery safely and retain its workflow ID. The later drafter and independent cross-check remain separate steps; intake completeness does not approve their output or permit deployment.

### 15. Run acceptance checks and enable gradually

Use an injected Bedrock test double for deterministic integration checks, then run a small public/synthetic fixture set against the configured AWS model and guardrail. Do not require identical model prose; assert schema validity, the expected disposition, evidence binding, and gate behavior.

- Complete requirements pass; missing or conflicting criteria produce actionable clarification. An unread guideline URL never supplies fabricated evidence.
- Embedded instructions cannot alter permissions or workflow state. Exercise configured personal-data and prompt-attack filters and verify interventions stop processing.
- Missing or changed source bytes, unknown references, oversized screening input, invalid JSON, contradictory decisions, and truncated output never pass.
- Throttling, timeout, access denial, invalid model configuration, and guardrail failure produce the appropriate recoverable or blocked state without downstream runs.
- Concurrent screening requests, duplicate responses, lease expiry, crash recovery, and late completion produce one authoritative result per screening generation.
- A correction, changed policy, or regenerated preview makes earlier confirmation unusable. Two POs cannot read or screen each other's revisions.
- Repeated confirmation and handoff retries produce one workflow. Every delivered snapshot traces to the same source versions, hashes, screening attempt, preview, and confirmation.

Roll out behind a server-side feature flag. First enable screening for test POs, then enable preview and confirmation, and finally handoff after the acceptance checks pass. Monitor latency, failures, guardrail interventions, retries, token usage, and aggregate AWS spend. Keep the sandbox's $250 and $400 budget alerts. Disable new screening or handoffs on rollback while retaining audit evidence; pending revisions remain blocked from downstream work.

**Definition of done** — A PO can sign in, submit public or synthetic guideline evidence, receive a Bedrock completeness result, correct a request, review a preview, and confirm the exact reviewed revision. Every decision is traceable to immutable evidence and versioned screening settings. Only a locally valid, screened, previewed, and confirmed revision can start one downstream workflow. Clinical review and release approval remain required later in the pipeline.

### AWS implementation references

Check model support and quotas in the target account during implementation. These AWS references inform the proposed integration:

- [Converse API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html) — request, response, and inference configuration.
- [Guardrail integration modes](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use.html) — inference integration and independent input assessment.
- [Guardrail runtime permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-permissions.html) — model invocation and guardrail application access.
