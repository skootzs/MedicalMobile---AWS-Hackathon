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
