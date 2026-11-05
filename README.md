# CHT No-Code Configuration

A hackathon project for building Community Health Toolkit configuration without writing code.

This README covers the infrastructure. To run the app on it, see
[docs/integration-handoff.md](docs/integration-handoff.md). Team roles are in
[docs/owners.md](docs/owners.md), and the reasoning behind each AWS choice is in
[docs/decisions.md](docs/decisions.md).

## Prerequisites

- Terraform 1.9
- AWS CLI v2 with the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
- Python 3 and OpenSSL
- Credentials for the hackathon AWS account, in `us-west-2`
- Docker and Node 22.18 or later, for building images and running the runner's tests

Everything that needs AWS or x86_64 runs on the Kiro workspace, using the ordered scripts in
[scripts/kiro/RUNBOOK.md](scripts/kiro/RUNBOOK.md).

## Deploy

```sh
TF_VAR_alarm_email=<address-for-error-alarms> scripts/deploy.sh
```

This runs `terraform apply` (it shows the plan and asks you to confirm), creates the demo users, and
writes the gitignored `.env`. Confirm the email SNS sends that address, or the alarm won't reach you.

Then:

1. Set the CHT login value in Secrets Manager. Terraform creates `cht-nocode/cht-login` empty.
2. Deploy the build runner with `scripts/kiro/31-deploy-runner.sh`.
3. Set up the CHT instance with `scripts/kiro/24-setup-cht.sh`.
4. Deploy the app, as described in [docs/integration-handoff.md](docs/integration-handoff.md).

## Teardown

```sh
scripts/teardown.sh                     # stops before destroying anything if the bucket holds artifacts
scripts/teardown.sh --delete-artifacts  # permanently deletes every artifact version, then destroys
```

`--delete-artifacts` asks you to type the bucket name first. Artifacts include build and release
evidence and can't be recovered. Terraform then shows its plan and asks you to confirm.

The Secrets Manager secret stays in its 30-day recovery window after a destroy, so deploying again
inside that window needs `aws secretsmanager delete-secret --secret-id cht-nocode/cht-login --force-delete-without-recovery` first.

## Sign-in

The app uses a Cognito user pool, with the authorization code flow and PKCE. The only allowed callback
and logout URL is `http://localhost:8080`, so open the port forward first:

```sh
aws ssm start-session --region us-west-2 --target "$(terraform -chdir=infra/terraform output -raw app_host_instance_id)" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8080"],"localPortNumber":["8080"]}'
```

`scripts/deploy.sh` creates one demo user per group, and prints each temporary password once. You'll
change it at first sign-in.

| Group | Demo username |
|---|---|
| `po` | `demo.po@cht-nocode.example` |
| `service_designer` | `demo.service_designer@cht-nocode.example` |
| `clinician` | `demo.clinician@cht-nocode.example` |
| `developer` | `demo.developer@cht-nocode.example` |
| `release_approver` | `demo.release_approver@cht-nocode.example` |

These are synthetic accounts. Re-running the script leaves existing users and their passwords alone.

## Cost controls

The team budget is $400. The hackathon manages the AWS Budget and its alerts, so this repo creates no
budget resources.

| Control | Details |
|---|---|
| Nightly stop | Both hosts stop at 23:00 America/Los_Angeles. They don't restart on their own: start them when needed |
| No NAT gateway | Hosts use the default VPC's public subnets, with no inbound rules |
| Pay per use | DynamoDB is on-demand, and SQS, S3 and EventBridge Pipes charge by use |
| Retention | CloudWatch logs last 7 days, and each ECR repository keeps its newest 10 images |
| Models | Develop against Haiku and fixtures, not Opus |

To see spend to date and tokens per run:

```sh
scripts/kiro/32-cost-report.sh
```

Bedrock calls through shared inference profiles aren't tagged, so tagged spend alone understates the
cost. The report also prints the account's Bedrock line for comparison.

Measured on the hackathon account at 5:00 PM Pacific on 4 Nov 2026, for 1 Oct 2026 through 5 Nov 2026. Cost Explorer lags by about a day. Tagged `project=cht-nocode` spend was $0.00. The whole account was $5.82: EC2 compute $4.34, CloudTrail $0.66, CloudWatch $0.29, EC2 other $0.25, VPC $0.21, Secrets Manager $0.05, GuardDuty $0.01. No Bedrock line appeared at or above $0.01.

In us-west-2, Claude Haiku 4.5 was 52 calls, 90,529 input tokens and 45,824 output tokens. Claude Sonnet 4.6 was 37 calls, 140,229 input tokens and 98,724 output tokens. The same account also recorded Luma and Stability image calls; those are not this pathway. Invocation logging is off, so these counts come from CloudWatch metrics. There is no DynamoDB table named `cht-nocode` in that account, so the report could not divide any of this by a pathway run. The team budget is $400 and the sandbox budget is $500. $5.82 is the whole account, not a per-run figure.

## What the child-cough pathway showed

On the Kiro workspace at 4:56 PM Pacific on 4 Nov 2026, commit `cdb0b7d`:

- `scripts/kiro/20-build-image.sh` built the image and launched Chromium.
- `scripts/kiro/25-fixture-end-to-end.sh` compiled the fixture, and cht-conf plus the form harness passed at compiler `7f488e6`.
- `scripts/kiro/29-verify-stage-e2e.sh` ran compile and then verify at verifier `e9f70f6`. With the golden cases, `verificationPassed` was true. Without them, the job still finished and `verificationPassed` was false, because those extra patients have no expected answer.

A clinician has not approved the golden cases. A Medic representative has not confirmed the demo.

| Well-Architected target | Evidence |
|---|---|
| Operational excellence | [Deploy](#deploy) and [Teardown](#teardown). One change is the request, the approval record, and the compile hashes |
| Security | Cognito sign-in in [Sign-in](#sign-in). Synthetic demo users only. Content approval and release approval are separate records, and the compile and verify runners are different actors |
| Reliability | A job starts as `PENDING` and can be ingested again. The checker blocks a release on a blocking finding. Teardown removes the stack |
| Performance efficiency | The Kiro run above. Models are used for drafting and screening. The compiler does not call a model |
| Cost optimization | The measured account spend above, the nightly stop, and [Teardown](#teardown). A per-run dollar figure needs the `cht-nocode` table |
| Sustainability | Hosts stop at 23:00 America/Los_Angeles and do not restart themselves. The shipped output is ordinary offline CHT configuration |

## Intake

See the [intake implementation guide](docs/intake-implementation-guide.md) for the original phase-one requirements and the phase-two Bedrock screening, preview, confirmation, and handoff plan.

See the [next-layer integration contract](docs/next-layer-integration.md) for all implemented API endpoints, request/response contracts, the queued handoff schema, and proposed orchestrator endpoints.

See [request storage and downstream handoff](docs/intake-storage-and-handoff.md) for configured resource locations, every persisted field, exact DynamoDB/S3 lookup keys, audit provenance, and downstream retrieval examples.

Phase one takes product owners from Cognito sign-in through submission, correction, and revision history. The intake service serves the browser UI and API from the same origin. It stores revision records in DynamoDB and source bytes in private, versioned S3. Guideline attachments support UTF-8 TXT and Markdown up to 256 KiB. URL references are stored without fetching their content.

### Run locally against AWS

1. Provision the resources in `infra/terraform`. Set `intake_name` to a globally unique lowercase name and `intake_callback_url` to `http://localhost:3000/`. For a hosted installation, use the HTTPS origin with a trailing slash.
2. Create test users in the Cognito pool. In the intake table, create a role assignment for each user who should have access. Use partition key `roles#<Cognito sub>`, sort key `assignment`, and a DynamoDB list of strings for `roles`. Assign `PO` to product owners. Role assignments are administered outside the intake service.
3. Give the runtime AWS credentials with the policy identified by `intake_runtime_policy_arn`. Export the values in `intake_environment`. Set `INTAKE_REGISTRY` to an absolute path to a server-controlled JSON file mapping configuration versions to lowercase SHA-256 digests of their configuration artifacts.
4. Run `npm install` and `npm start` with Node.js 22 or later. Startup also reads optional local settings from the repository-root `.env` (ignored by Git); already exported environment variables take precedence. Open the configured callback URL. Run `npm test` for the local intake tests.

After sign-in, **Profile** shows the verified username, user ID, and recognized roles from the server-managed DynamoDB assignment. **Log out** clears the local session and redirects through Cognito sign-out to the `/signed-out` confirmation page. Apply the Cognito Terraform change to register that page as an allowed sign-out URL (`http://localhost:3000/signed-out` locally). Sign-in requests require fresh authentication. For an existing manually managed app client, add the confirmation page URL under allowed sign-out URLs.

If sign-in reports that the server cannot load AWS credentials, authenticate the AWS profile used by the server (for example, `aws sso login --profile medic-intake`). Credential files are reloaded when credentials need resolution, so a server started before that login can recover. Click **Sign in with Cognito** again to obtain a new authorization code. Changing `AWS_PROFILE` or exporting credentials in another terminal does not update an already running process. Restart `npm start` from the terminal with the intended environment in that case. The browser's Cognito login and the server's AWS credentials are separate, and the server needs AWS access to read the PO role in DynamoDB.

### Verify against the provisioned resources

- Sign in with two PO accounts and one account without the PO role. Try invalid Cognito credentials and missing, expired, and invalid access tokens. Check that each PO sees only their own requests and that direct requests for another PO's request or revision return 404.
- Submit a request, then correct it and check that the request ID remains stable. Replay the same JSON bytes and idempotency key concurrently. Check that both responses identify the same revision and that changing the payload under the same key returns 409.
- For each source in a revision response, retrieve the recorded S3 object version and recompute SHA-256 over its bytes. Compare the stored baseline hash to the registry and use `serializeRequirements` to reproduce the requirements hash. Verify each reference points to a source object key and version listed on that revision.
- Submit an invalid baseline or a malformed attachment. Check for a blocked revision and correction message. Submit a valid attachment containing embedded instructions and check for `pending_screening` and an unchanged source hash. Both statuses remain at the intake boundary.

The API buffers up to 400 KiB of submission JSON. Larger bodies up to 3,200 KiB produce a blocked revision without storing the oversized body. Bodies above that transport cap are rejected.

## Phase two: screening and PO review

The intake service now supports Bedrock completeness screening, clarification questions, a deterministic visual request summary, and confirmation of the exact previewed revision. Confirmation atomically saves a durable queued handoff snapshot. The orchestrator is still a scaffold: no workflow is dispatched yet, and the UI explicitly reports the queued state. This preview summarizes the request; clinical decision-tree generation and clinical review belong to the downstream drafter.

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

The next integration is an outbox consumer. It must recheck the current revision, screening policy, preview and confirmation before dispatch, deduplicate using the revision ID, and record the workflow ID. Corrections or policy changes can make an already queued record stale. Do not dispatch by trusting the queued snapshot alone. No deployment or live-model smoke test is performed by `npm test`.
