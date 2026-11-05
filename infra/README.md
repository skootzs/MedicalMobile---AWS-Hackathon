# AWS infrastructure

[terraform/](terraform/) defines the AWS sandbox in `us-west-2`. [intake.tf](terraform/intake.tf) defines the intake resources and runtime configuration separately from the downstream build workflow. The downstream stack uses Cognito for identity, DynamoDB for workflow and job records, versioned S3 for artifacts, and EventBridge Pipes with SQS for job delivery and completion events. EC2 hosts run the app and CHT. The host bootstrap scripts configure the instances for their respective roles.

## Resource layout

| Files | Responsibility |
| --- | --- |
| [intake.tf](terraform/intake.tf) and [bedrock.tf](terraform/bedrock.tf) | Intake resources, screening configuration, and runtime permissions |
| [dynamodb.tf](terraform/dynamodb.tf), [s3.tf](terraform/s3.tf), [sqs.tf](terraform/sqs.tf), and [pipes.tf](terraform/pipes.tf) | Workflow state, artifacts, and delivery of jobs and completion events |
| [ec2.tf](terraform/ec2.tf) and [bootstrap/](terraform/bootstrap/) | App and CHT hosts and their startup configuration |
| [outputs.tf](terraform/outputs.tf) and [iam.tf](terraform/iam.tf) | Resource names for service configuration and the app host role |

Run the commands below from the repository root. See the [integration handoff](../docs/integration-handoff.md) for application environment variables and the [Kiro runbook](../scripts/kiro/RUNBOOK.md) for the ordered AWS setup. For intake's separate Cognito configuration, see the [intake guide](../packages/intake/README.md#run-locally-against-aws).

## Prerequisites

- Terraform 1.9
- AWS CLI v2 with the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
- Python 3 and OpenSSL
- Credentials for the hackathon AWS account, in `us-west-2`
- Docker and Node 22.18 or later, for building images and running the runner's tests

Everything that needs AWS or x86_64 runs on the Kiro workspace, using the ordered scripts in
[scripts/kiro/RUNBOOK.md](../scripts/kiro/RUNBOOK.md).

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
4. Deploy the app, as described in [docs/integration-handoff.md](../docs/integration-handoff.md).

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
