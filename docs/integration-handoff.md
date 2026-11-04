# Integration handoff

What R7 provides for the integrator, who owns the compose stack, the orchestrator and UI
images, and the app-level deploy. R7 owns the infrastructure and the build runner.

Region: `us-west-2`. Read live values with `terraform -chdir=infra/terraform output`, or from
`/etc/cht-nocode/env` on the app host.

## Must do for jobs to run

R7's side is deployed separately (`scripts/kiro/31-deploy-runner.sh`), but no job completes
until these are wired up. Current status of each is in
[job-delivery.md](./job-delivery.md#r2-alignment-still-needed).

1. **Consume `job-events`.** Nothing reads this queue yet. Each message is
   `{ requestId, jobId, status, attempt }`. Read it, call R2's reconciler (`reconciler.ts`,
   an in-process service), and delete the message. Without this, R2 never learns a job finished.
2. **Register the runner's service actors with R2.** The runner records itself as
   `cht-runner-compile` and `cht-runner-verify`. R2 needs both in `resolveServiceActor`, with the
   COMPILER and VERIFIER roles, and it needs to supply its `CompilationArtifactVerifier`.
3. **Don't send to or read from the jobs queue.** R2 writes `JOB#<id>/OUTBOX` in its transaction,
   and an EventBridge Pipe delivers it.

## Environment variables

**Where they come from:**

- **Bootstrap:** `/etc/cht-nocode/env` on the app host, written by `app-host.sh` at first boot.
  `31-deploy-runner.sh` adds any missing `JOB_EVENTS_*`, `CHT_SECRET_NAME` and `BEDROCK_GUARDRAIL_*` lines.
- **`13-write-env.sh`:** a gitignored `.env` in the repo root, for where Terraform state lives (Kiro).
- **Installer:** `/etc/cht-nocode/runner.env`, written by `runner/install-runner.sh`. Runner only.

Use `env_file: /etc/cht-nocode/env` in compose to get the shared values.

| Variable | Used by | Written by |
|---|---|---|
| `AWS_REGION` | all | Bootstrap, `13-write-env.sh` |
| `PROJECT_TAG` | tagging | Bootstrap, `13-write-env.sh` |
| `MODE` | orchestrator (`aws` or `local`) | Bootstrap only |
| `ARTIFACT_BUCKET` | orchestrator, runner | Bootstrap, `13-write-env.sh` |
| `DDB_TABLE` | orchestrator, runner | Bootstrap, `13-write-env.sh` |
| `JOBS_QUEUE_URL` | runner | Bootstrap, `13-write-env.sh` |
| `JOBS_DLQ_URL` | operators | Bootstrap, `13-write-env.sh` |
| `JOB_EVENTS_QUEUE_URL` | your job-events consumer | Bootstrap, `13-write-env.sh` |
| `JOB_EVENTS_DLQ_URL` | operators | Bootstrap, `13-write-env.sh` |
| `COGNITO_USER_POOL_ID` | orchestrator, UI | Bootstrap, `13-write-env.sh` |
| `COGNITO_CLIENT_ID` | orchestrator, UI | Bootstrap, `13-write-env.sh` |
| `CHT_SECRET_NAME` | whatever deploys to CHT | Bootstrap, `13-write-env.sh` |
| `BEDROCK_GUARDRAIL_ID` | drafter | Bootstrap, `13-write-env.sh` |
| `BEDROCK_GUARDRAIL_VERSION` | drafter | Bootstrap, `13-write-env.sh` |
| `BEDROCK_DRAFT_MODEL_ID` | drafter | **Nothing yet.** Set it yourself once R3 confirms the ID |
| `BEDROCK_FAST_MODEL_ID` | drafter | **Nothing yet**, as above |
| `BEDROCK_CROSSCHECK_MODEL_ID` | drafter | **Nothing yet**, as above |
| `WORKER_ID` | runner | Installer (`cht-runner`) |
| `COMPILE_IMAGE` | runner | Installer (`node:22.23.4-slim`) |
| `BUILD_IMAGE` | runner | Installer (the ECR `build-image` tag) |
| `COMPILER_DIR`, `COMPILER_COMMIT` | runner | Installer (`7f488e6`) |
| `TEMPLATE_DIR` | runner | Installer |
| `VERIFIER_DIR`, `VERIFIER_COMMIT` | runner | Installer (`e9f70f6`) |
| `RUNNER_WORK_DIR` | runner | Installer |
| `CHT_CONF_VERSION` | runner | Optional, defaults to `6.6.1` |
| `LEASE_SECONDS` | runner | Optional, defaults to `900` |
| `BUILD_TIMEOUT_SECONDS` | runner | Optional, defaults to `600` |
| `MAX_RECEIVE_COUNT` | runner | Optional, defaults to `3` |

The orchestrator also reads `HOST` and `PORT`, which default to `0.0.0.0` and `8080` in its image.

## ECR

Get the URLs with `terraform -chdir=infra/terraform output ecr_repository_urls`.

| Repository | Owner | Use |
|---|---|---|
| `cht-nocode/orchestrator` | Integrator | Orchestrator image |
| `cht-nocode/ui` | Integrator | UI image |
| `cht-nocode/worker` | R7 | Runner bundle. Don't push here |
| `cht-nocode/build-image` | R7 | Stage image. Don't push here |

Tags are immutable, so use a new tag for each push, such as the git commit. Each repository keeps
its newest 10 images. Build `linux/amd64`, because both hosts are x86_64.

```sh
REGISTRY=<account-id>.dkr.ecr.us-west-2.amazonaws.com
TAG="$(git rev-parse --short=12 HEAD)"
aws ecr get-login-password --region us-west-2 | docker login --username AWS --password-stdin "$REGISTRY"
docker build --platform linux/amd64 -t "$REGISTRY/cht-nocode/orchestrator:$TAG" ./packages/orchestrator
docker push "$REGISTRY/cht-nocode/orchestrator:$TAG"
```

Push from Kiro. The app host's role can pull but not push. To pull on the host, log in the same way.

## Reaching the app host

Neither host has inbound rules or SSH. Everything goes through SSM, which needs the
[Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
on your machine.

```sh
# Shell on the app host
aws ssm start-session --region us-west-2 --target <app_host_instance_id>

# The app on http://localhost:8080, which is Cognito's only allowed callback and logout URL
aws ssm start-session --region us-west-2 --target <app_host_instance_id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8080"],"localPortNumber":["8080"]}'
```

Get the instance ID with `terraform -chdir=infra/terraform output -raw app_host_instance_id`.

## Ports and network

| Port | What | Notes |
|---|---|---|
| 8080 on the app host | Orchestrator or UI, whichever you publish | Reached only through the port forward |
| None | Runner | It only makes outbound calls |

- **Outbound is 443 only.** AWS APIs, ECR and Docker Hub work. Anything on port 80 fails, and that
  includes Ubuntu's default apt mirrors, so install nothing on the host with `apt` and build images on Kiro.
- **Containers can use the instance role.** IMDSv2's hop limit is 2, so don't pass AWS keys.
- **Hosts stop at 23:00 America/Los_Angeles.** Use a restart policy (`restart: unless-stopped`) so
  the stack comes back when a host starts again. The runner restarts on its own.

## What the app host role allows

The orchestrator, UI and runner share this one role.

| Service | Allowed | On | Not allowed |
|---|---|---|---|
| S3 | `GetObject`, `GetObjectVersion`, `ListBucket` | Artifact bucket | `DeleteObject` |
| S3 | `PutObject` | `snapshots/*`, `builds/*`, `previews/*`, `sources/*` only | Other prefixes |
| DynamoDB | `GetItem`, `PutItem`, `UpdateItem`, `Query`, `TransactWriteItems`, `ConditionCheckItem` | Table and its indexes | `DeleteItem`, `Scan`, batch operations |
| SQS | `SendMessage`, `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `GetQueueAttributes` | Jobs and job-events queues and their DLQs | |
| Secrets Manager | `GetSecretValue` | `cht-nocode/cht-login` only | |
| ECR | Pull, `DescribeImages` | The four repositories | Push |
| CloudWatch Logs | `CreateLogStream`, `PutLogEvents`, `DescribeLogStreams` | `/cht-nocode/app` | |
| Bedrock | `InvokeModel`, `InvokeModelWithResponseStream` | `us.anthropic.*` profiles and `amazon.nova-*` in us-west-2 | Other models |
| Bedrock | `ApplyGuardrail` | The PII guardrail | |
| Cognito | `ListUsers`, `AdminGetUser` | The user pool | Any write |
| SSM | `AmazonSSMManagedInstanceCore` | | |

**Logs:** send app logs to `/cht-nocode/app` with Docker's `awslogs` driver. The error alarm fires on
`level=error` lines there.

## What the runner expects

The runner is a systemd service on the app host (`cht-build-runner`), not part of compose. Check it
with `systemctl status cht-build-runner` and `journalctl -u cht-build-runner`.

| It needs | Details |
|---|---|
| Jobs queue | Receives from `cht-nocode-jobs`. Messages come from the outbox Pipe, as whole stream records holding `dynamodb.NewImage.payload` |
| Table | `JOB#<jobId>/META` must exist before delivery, with `status = PENDING` and a `requestId` |
| Payload | Must match `JobPayload` or `VerifyBuildPayload` in `packages/schema/src/handoffs.ts`. The schemas are closed, so an unknown field fails the job with `INVALID_PAYLOAD` |
| Approval | For `mode = approved`: `REQ#<requestId>/APPROVAL#<clinicalApprovalId>` with `decision = approved` and a matching `logicModelHash` |
| Bucket | `snapshotUri`, `packageUri`, `baselineUri` and `goldenCasesUri` must all be inside `ARTIFACT_BUCKET`. The object at `snapshotUri` must hash to `logicModelHash` |
| Docker | It starts stage containers on the host's Docker. Leave those images in place, and leave disk space for them |

It writes results to `JOB#<jobId>/META` and artifacts under `builds/` or `previews/`. See
[job-delivery.md](./job-delivery.md) for fields, retries and failure codes.
