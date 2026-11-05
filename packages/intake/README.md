# Configuration request intake

Intake is the product owner's entry point. It serves the [browser workspace](../ui/README.md) and the request API from the same origin.

## How it works

1. Cognito authenticates the user. The server checks their product owner role in DynamoDB and limits access to requests they own.
2. Submission validates the requested baseline against a server-side registry, normalizes the requirements, and saves an immutable revision. Corrections create a new revision under the same request ID. An idempotency key protects retries of the same submission.
3. When enabled, Bedrock screens the current revision for completeness and returns blockers or clarification suggestions. The product owner resolves them through a correction and screens the resulting revision.
4. After screening passes, intake creates a deterministic request preview. Confirming its exact revision, screening attempt, and preview hash writes the confirmation and queued handoff together.

| File | Responsibility |
| --- | --- |
| [server.js](server.js) | Cognito session and profile, HTTP routes, and UI hosting |
| [intake.js](intake.js) | Submission validation, normalization, and revision records |
| [screening.js](screening.js) and [suggestions.js](suggestions.js) | Bedrock screening and clarification suggestions |
| [review.js](review.js) | Screening attempts, previews, corrections, and confirmation |
| [storage.js](storage.js) | DynamoDB records and versioned S3 source objects |

## API and storage

See the [intake implementation guide](../../docs/intake-implementation-guide.md) for the original phase-one requirements and the phase-two Bedrock screening, preview, confirmation, and handoff plan.

See the [next-layer integration contract](../../docs/next-layer-integration.md) for all implemented API endpoints, request/response contracts, the queued handoff schema, and proposed orchestrator endpoints.

See [request storage and downstream handoff](../../docs/intake-storage-and-handoff.md) for configured resource locations, every persisted field, exact DynamoDB/S3 lookup keys, audit provenance, and downstream retrieval examples.

Phase one takes product owners from Cognito sign-in through submission, correction, and revision history. The intake service serves the browser UI and API from the same origin. It stores revision records in DynamoDB and source bytes in private, versioned S3. Guideline attachments support UTF-8 TXT and Markdown up to 256 KiB. URL references are stored without fetching their content.

| Record | What to inspect |
| --- | --- |
| Revision | Request and revision IDs, normalized requirements, baseline hash, and each source's S3 key, version, and SHA-256 digest |
| Current revision pointer | The revision eligible for new review actions after a correction |
| Review state | Screening policy and attempt, preview hash, and any rejection or confirmation |
| Queued handoff | The confirmed revision and evidence that downstream dispatch must recheck |

For a local rehearsal with no AWS account, use the [fixture workspace](../ui/README.md#try-the-workspace). It runs the intake and review logic with test identities, in-memory records, and injected screening responses.

## Run locally against AWS

1. Provision the resources in `infra/terraform`. Set `intake_name` to a globally unique lowercase name and `intake_callback_url` to `http://localhost:3000/`. For a hosted installation, use the HTTPS origin with a trailing slash.
2. Create test users in the Cognito pool. In the intake table, create a role assignment for each user who should have access. Use partition key `roles#<Cognito sub>`, sort key `assignment`, and a DynamoDB list of strings for `roles`. Assign `PO` to product owners. Role assignments are administered outside the intake service.
3. Give the runtime AWS credentials with the policy identified by `intake_runtime_policy_arn`. Export the values in `intake_environment`. Set `INTAKE_REGISTRY` to an absolute path to a server-controlled JSON file mapping configuration versions to lowercase SHA-256 digests of their configuration artifacts.
4. From the repository root, run `npm ci` and `npm start` with Node.js 22.18 or later. Startup also reads optional local settings from the repository-root `.env` (ignored by Git); already exported environment variables take precedence. Open the configured callback URL. Run `node --test packages/intake/*.test.js` from the root for the intake suite.

After sign-in, **Profile** shows the verified username, user ID, and recognized roles from the server-managed DynamoDB assignment. **Log out** clears the local session and redirects through Cognito sign-out to the `/signed-out` confirmation page. Apply the Cognito Terraform change to register that page as an allowed sign-out URL (`http://localhost:3000/signed-out` locally). Sign-in requests require fresh authentication. For an existing manually managed app client, add the confirmation page URL under allowed sign-out URLs.

If sign-in reports that the server cannot load AWS credentials, authenticate the AWS profile used by the server (for example, `aws sso login --profile medic-intake`). Credential files are reloaded when credentials need resolution, so a server started before that login can recover. Click **Sign in with Cognito** again to obtain a new authorization code. Changing `AWS_PROFILE` or exporting credentials in another terminal does not update an already running process. Restart `npm start` from the terminal with the intended environment in that case. The browser's Cognito login and the server's AWS credentials are separate, and the server needs AWS access to read the PO role in DynamoDB.

## Verify against the provisioned resources

- Sign in with two PO accounts and one account without the PO role. Try invalid Cognito credentials and missing, expired, and invalid access tokens. Check that each PO sees only their own requests and that direct requests for another PO's request or revision return 404.
- Submit a request, then correct it and check that the request ID remains stable. Replay the same JSON bytes and idempotency key concurrently. Check that both responses identify the same revision and that changing the payload under the same key returns 409.
- For each source in a revision response, retrieve the recorded S3 object version and recompute SHA-256 over its bytes. Compare the stored baseline hash to the registry and use `serializeRequirements` to reproduce the requirements hash. Verify each reference points to a source object key and version listed on that revision.
- Submit an invalid baseline or a malformed attachment. Check for a blocked revision and correction message. Submit a valid attachment containing embedded instructions and check for `pending_screening` and an unchanged source hash. Both statuses remain at the intake boundary.

The API buffers up to 400 KiB of submission JSON. Larger bodies up to 3,200 KiB produce a blocked revision without storing the oversized body. Bodies above that transport cap are rejected.

## Phase two: screening and PO review

The intake service supports Bedrock completeness screening, clarification questions, a deterministic visual request summary, and confirmation of the exact previewed revision. Confirmation atomically saves a durable queued handoff snapshot. The standard `npm start` entry point stops at the queued handoff. The [drafter](../drafter/README.md) proposes clinical logic downstream, and the [orchestrator](../orchestrator/README.md) records human review.

Screening defaults to disabled. To enable it in the sandbox:

1. Select a Converse-compatible model available in the target account. Set Terraform's `intake_screening_enabled = true`, `intake_bedrock_model_id`, and `intake_bedrock_model_arns` (the exact model/profile resources and any required destination models). Verify inference-profile destination Regions before using a profile.
2. Review and apply Terraform. It provisions a published guardrail with prompt-attack and sensitive-information filters and adds runtime invocation permissions. Export `intake_screening_environment` alongside the existing intake environment. Set `AWS_REGION=us-west-2` for the sandbox. Never use the guardrail's draft version in runtime configuration.
3. Restart the intake service. Missing enabled-screening configuration causes startup failure. Optional limits are `BEDROCK_TIMEOUT_MS` (default 20000, maximum 60000), `BEDROCK_MAX_INPUT_BYTES` (default 12000, maximum 16000), and `BEDROCK_MAX_OUTPUT_TOKENS` (default 4096, maximum 4096). Input exceeding the configured limit is blocked without truncation. The conservative input cap also bounds the pre-inference guardrail request.
4. Sign in as a PO, submit the written request with optional guideline links or a public/synthetic TXT or Markdown excerpt, open the request, and choose **Screen this revision**. Uploads are not required for submission or screening. Bedrock assesses the written requirements even without an attachment; links are references whose contents have not been fetched. Resolve clarification by correcting the request, which creates a new revision.
5. After screening passes, create the request preview, review it, and confirm it. The server binds confirmation to the revision, screening policy/attempt, and preview hash. Confirming an older revision after a correction is rejected. Existing phase-one records acquire their current-revision pointer on first preview without overwriting a concurrent submission.

Revision records remain immutable. Screening state, append-only attempt events, previews, confirmation, and the queued snapshot are stored separately under the authenticated author's partition. Each explicit **Screen again** action starts a new Bedrock screening attempt after the prior attempt finishes and invalidates any unconfirmed preview. GET only retrieves the current state. Active attempts are reused to suppress duplicate concurrent calls; leases expire after three minutes. Confirmed revisions require a correction before screening again, preserving queued handoffs. The SDK makes at most two attempts per AWS operation. Late responses cannot replace a newer screening attempt. Ordinary logs and UI errors do not expose model traces or submitted content.

Protected revision routes (all preserve ownership checks):

| Method | Route suffix after `/api/requests/:requestId/revisions/:revisionId` | Body |
| --- | --- | --- |
| GET | `/screening` | None |
| POST | `/screening` | `{}` |
| POST | `/preview` | `{}` |
| POST | `/rejection` | `previewId`, `previewHash`, `attemptId`, nonempty `feedback` |
| POST | `/revise` | `attemptId`, `selections: [{ id, replacement, acceptAssumption? }]`; `Idempotency-Key` required |
| POST | `/confirmation` | `previewId`, `previewHash`, `attemptId`, `feedback` (up to 4,000 characters) |

Before enabling for real users, run public/synthetic screening fixtures with the actual configured model and guardrail, verify the runtime role cannot invoke an unapproved model, and verify guardrail interventions, timeouts, and invalid configuration cannot pass. Set the sandbox budget alerts at $250 and $400. Local tests use injected Bedrock responses and do not establish live model quality or deployed IAM behavior.

The next integration is an outbox consumer. It must recheck the current revision, screening policy, preview and confirmation before dispatch, deduplicate using the revision ID, and record the workflow ID. Corrections or policy changes can make an already queued record stale. Do not dispatch by trusting the queued snapshot alone. Local tests use fixtures. A deployed smoke test requires AWS resources and credentials.
