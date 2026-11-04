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
scripts/deploy.sh
```

This runs `terraform apply` (it shows the plan and asks you to confirm), creates the demo users, and
writes the gitignored `.env`.

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

## Intake

See the [intake implementation guide](docs/intake-implementation-guide.md) for the original phase-one requirements and the phase-two Bedrock screening, preview, confirmation, and handoff plan.

Phase one takes product owners from Cognito sign-in through submission, correction, and revision history. The intake service serves the browser UI and API from the same origin. It stores revision records in DynamoDB and source bytes in private, versioned S3. Guideline attachments support UTF-8 TXT and Markdown up to 256 KiB. URL references are stored without fetching their content.

### Run locally against AWS

1. Provision the resources in `infra/terraform`. Set `intake_name` to a globally unique lowercase name and `intake_callback_url` to `http://localhost:3000/`. For a hosted installation, use the HTTPS origin with a trailing slash.
2. Create test users in the Cognito pool. In the intake table, create a role assignment for each user who should have access. Use partition key `roles#<Cognito sub>`, sort key `assignment`, and a DynamoDB list of strings for `roles`. Assign `PO` to product owners. Role assignments are administered outside the intake service.
3. Give the runtime AWS credentials with the policy identified by `intake_runtime_policy_arn`. Export the values in `intake_environment`. Set `INTAKE_REGISTRY` to an absolute path to a server-controlled JSON file mapping configuration versions to lowercase SHA-256 digests of their configuration artifacts.
4. Run `npm install` and `npm start` with Node.js 22 or later. Open the configured callback URL. Run `npm test` for the local intake tests.

### Verify against the provisioned resources

- Sign in with two PO accounts and one account without the PO role. Try invalid Cognito credentials and missing, expired, and invalid access tokens. Check that each PO sees only their own requests and that direct requests for another PO's request or revision return 404.
- Submit a request, then correct it and check that the request ID remains stable. Replay the same JSON bytes and idempotency key concurrently. Check that both responses identify the same revision and that changing the payload under the same key returns 409.
- For each source in a revision response, retrieve the recorded S3 object version and recompute SHA-256 over its bytes. Compare the stored baseline hash to the registry and use `serializeRequirements` to reproduce the requirements hash. Verify each reference points to a source object key and version listed on that revision.
- Submit an invalid baseline or a malformed attachment. Check for a blocked revision and correction message. Submit a valid attachment containing embedded instructions and check for `pending_screening` and an unchanged source hash. Both statuses remain at the intake boundary.

The API buffers up to 400 KiB of submission JSON. Larger bodies up to 3,200 KiB produce a blocked revision without storing the oversized body. Bodies above that transport cap are rejected.
