# Connected workspace UI

The Community Health Toolkit design now lives in the main repository. Start the application with the existing `npm start` command and existing Cognito/AWS configuration. No deployment or infrastructure changes are included.

## Connected behaviour

- Homepage **New request** starts a fresh intake form. Upload buttons open the same form and focus its optional attachment field.
- **Local protocols** reads the authenticated author's requests, groups immutable revisions by request ID, and reads evolving status separately from the screening endpoint. Review reads use at most four concurrent requests; individual failures remain visible and can be retried with Refresh requests.
- Request tracking uses the existing six-stage intake model. The primary action invokes the existing explicit screening/preview controls, opens manual correction, or takes the user to exact-preview confirmation. It never confirms on the user's behalf.
- Saved summaries include normalized requirements, baseline, source hashes, references, and revision events. Audit history exposes available information, not a complete clinical audit log.
- Cognito PKCE, verified profile, in-memory access tokens, logout, and safe return routes are retained. Expiration clears the displayed request data. Deep links are served through the same origin.
- Conflicting review actions reload request history and review state. They are not retried automatically. Uncertain submissions retain their exact payload and idempotency key; Start fresh explicitly allocates a new submission context.

## Deliberate limits

- Intake still accepts only an optional single UTF-8 TXT/Markdown attachment up to 256 KiB. There is no PDF/DOCX upload, extraction, browser-local document store, or PDF dependency in this migration.
- Ask searches the sample reference library; it does not provide AI clinical answers. Reference collections, bookmarks, print, and browser-local viewing history retain their reference-only behaviour.
- Clinical approval, drafting/compilation, synthetic-patient testing, workflow execution, and release downloads remain unavailable. Successful PO confirmation means **Request confirmed. Handoff queued.**
- No APIs, processing schemas, Bedrock prompts, policy fingerprints, stored preview bindings, confirmation payloads, outbox records, or downstream processing files were changed. The intake server change only delegates static routes/assets to the UI responder and preserves its original content security policy.
- The two request lists derive latest revisions from received timestamps for display; backend current-revision gates remain authoritative.

## Verification

Run `npm test` for the original intake tests plus UI/controller/hosting integration coverage. The local HTTP integration test requires permission to bind a loopback port.

The browser test host is isolated under `packages/ui/test/test-server.js`. It exercises the real, unchanged intake and review services using in-memory storage and an injected test screener. It is not imported by `npm start`, is not served as a browser asset, and cannot activate fixture identity in production. Run it explicitly with `node packages/ui/test/test-server.js` when developing UI tests; it binds only `127.0.0.1:3197`.

Verified on November 4, 2026:

- All 50 tests pass, including the 38 existing backend and browser-contract tests without changed assertions.
- Controller tests cover fresh form/attachment routing, exact retries, expired sessions, read-only opening of requests, and stale confirmation refresh without a repeated POST.
- Hosting and service integration tests cover route/asset allowlists, security headers, ownership, normalization, attachment rejection, correction revisions, preview bindings, and queued handoff.
- Browser checks cover sign-in return to deep links, submission without an attachment, explicit screening, exact confirmation, fresh screening after correction, clarification context, grouped lists, profile, logout, sample reference search, and mobile drawer navigation.
- Desktop and 390 CSS-pixel mobile checks show no page-wide horizontal overflow; the protocol table scrolls within its container.

No live Cognito, Bedrock, DynamoDB, or S3 calls were made during verification. Live environment credentials, IAM permissions, and model behaviour remain environment-dependent.

Screenshots use synthetic test records: [homepage](home-desktop.jpg), [request tracking](tracking-desktop.jpg), [protocols](protocols-desktop.jpg).
