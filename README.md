# Configuration request intake

See the [intake implementation guide](docs/intake-implementation-guide.md) for the original phase-one requirements and the phase-two Bedrock screening, preview, confirmation, and handoff plan.

Phase one takes product owners from Cognito sign-in through submission, correction, and revision history. The intake service serves the browser UI and API from the same origin. It stores revision records in DynamoDB and source bytes in private, versioned S3. Guideline attachments support UTF-8 TXT and Markdown up to 256 KiB. URL references are stored without fetching their content.

## Run locally against AWS

1. Provision the resources in `infra/terraform`. Set `intake_name` to a globally unique lowercase name and `intake_callback_url` to `http://localhost:3000/`. For a hosted installation, use the HTTPS origin with a trailing slash.
2. Create test users in the Cognito pool. In the intake table, create a role assignment for each user who should have access. Use partition key `roles#<Cognito sub>`, sort key `assignment`, and a DynamoDB list of strings for `roles`. Assign `PO` to product owners. Role assignments are administered outside the intake service.
3. Give the runtime AWS credentials with the policy identified by `intake_runtime_policy_arn`. Export the values in `intake_environment`. Set `INTAKE_REGISTRY` to an absolute path to a server-controlled JSON file mapping configuration versions to lowercase SHA-256 digests of their configuration artifacts.
4. Run `npm install` and `npm start` with Node.js 22 or later. Open the configured callback URL. Run `npm test` for the local intake tests.

## Verify against the provisioned resources

- Sign in with two PO accounts and one account without the PO role. Try invalid Cognito credentials and missing, expired, and invalid access tokens. Check that each PO sees only their own requests and that direct requests for another PO's request or revision return 404.
- Submit a request, then correct it and check that the request ID remains stable. Replay the same JSON bytes and idempotency key concurrently. Check that both responses identify the same revision and that changing the payload under the same key returns 409.
- For each source in a revision response, retrieve the recorded S3 object version and recompute SHA-256 over its bytes. Compare the stored baseline hash to the registry and use `serializeRequirements` to reproduce the requirements hash. Verify each reference points to a source object key and version listed on that revision.
- Submit an invalid baseline or a malformed attachment. Check for a blocked revision and correction message. Submit a valid attachment containing embedded instructions and check for `pending_screening` and an unchanged source hash. Both statuses remain at the intake boundary.

The API buffers up to 400 KiB of submission JSON. Larger bodies up to 3,200 KiB produce a blocked revision without storing the oversized body. Bodies above that transport cap are rejected.
