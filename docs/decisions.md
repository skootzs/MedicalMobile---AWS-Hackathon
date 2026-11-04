# Decisions

## AWS services

The constraints: `us-west-2`, a $400 team budget, containers on EC2, no inbound access, and no
long-lived keys.

| Service | Used for | Why |
|---|---|---|
| EC2 (two `t3.large`, x86_64) | App host and CHT host | The CHT image is amd64-only, and the build stages need Docker with custom flags. Stops overnight, so it's cheap |
| Systems Manager | Shell access and port forwarding | No SSH, open ports or keys to manage |
| S3 | Snapshots, build artifacts, previews, sources | Private, versioned and encrypted. Versions give R2 immutable evidence references |
| DynamoDB | Single table for requests, jobs, approvals and audit | Transactions make job intent, audit and outbox one atomic write. On-demand costs nothing when idle |
| SQS | Jobs queue and job-events queue, each with a DLQ | Visibility timeouts and redelivery back the runner's leases and retries, and the DLQ makes failures visible |
| EventBridge Pipes | Stream to queue delivery, for outbox and job events | Delivery comes from committed table changes, so it can't disagree with the table, and no publisher code is needed |
| Cognito | Sign-in and role groups | Managed identity, with roles carried in `cognito:groups` |
| ECR | Runner, stage and app images | Immutable tags and scan on push. Hosts pull with their role, not a key |
| Secrets Manager | CHT login | Value is set by hand, so it never enters Terraform state or the repo |
| Bedrock, with a guardrail | Model calls, with PII blocked on inputs | The hackathon's required model route. The guardrail is a second defence for the synthetic-data rule |
| CloudWatch and SNS | Log group, 7-day retention, error alarm by email | The minimum needed to notice failures |
| EventBridge Scheduler | Nightly stop for both hosts | The biggest cost saving, and scoped to these two instances only |
| IAM | Instance and Pipe roles | Least privilege, with no access keys |

**Rejected:**

| Option | Why not |
|---|---|
| NAT gateway | Costs more than the rest of the network, and hosts don't need private subnets without inbound rules |
| Fargate, ECS | Stage containers need Docker flags and sibling containers. EC2 is simpler here |
| Lambda for app logic | Builds take minutes and need containers |
| Elastic Beanstalk, SageMaker, RDS | Not needed, and outside the project's constraints |
| Our own AWS Budget | The hackathon manages one, and IAM denies changing it |
| Step Functions, ALB | Not needed for one workflow reached through a port forward. Their Terraform files are placeholders |

**Known limits:**

- **Shared instance role:** the orchestrator, UI and runner all share one role on the app host. Per-service roles would need ECS.
- **Port 443 egress only:** Ubuntu's default apt mirrors use port 80, so `apt` can't reach them. If a
  new host's first-boot install fails because of this, `31-deploy-runner.sh` reports it.
- **Runner logs:** they stay in journald on the host, so the CloudWatch error alarm doesn't see them.

## Runner on the host, delivered as an image

**Decision:** the runner runs under systemd on the app host. The ECR `worker` image delivers it: the
installer copies the runner, compiler, template and verifier out of the image to `/opt/cht-nocode`.

The runner starts stage containers with host paths for their mounts. Inside a container it would need
the Docker socket and matching paths on both sides. On the host, neither is an issue, and no container
gets the socket. The runner is still privileged, since membership of the `docker` group is equivalent to
root on that host, so its only inputs are validated, hash-checked jobs.

## Chromium in the verify stage: no capabilities, `--no-sandbox`

**Decision:** the harness and verify stages run with `--cap-drop ALL` and no added
capabilities, and Chromium starts with `--no-sandbox`.

Chromium's sandbox crashed under the original flags (`--cap-drop ALL --cap-add SYS_ADMIN`)
with `ChrootToSafeEmptyDir` and a zygote signal 6. `scripts/kiro/27-chromium-sandbox-matrix.sh`
started the real harness under five flag sets on the x86 Kiro workspace:

| Variant | Flags | Result |
|---|---|---|
| a | `--cap-drop ALL --cap-add SYS_ADMIN` | FAIL |
| b | a + `SYS_CHROOT`, `SETUID`, `SETGID` | PASS |
| c | Docker's default capabilities + `SYS_ADMIN` | PASS |
| d | `--cap-drop ALL`, Chromium `--no-sandbox` | PASS (chosen) |
| e | a + `seccomp=unconfined` (diagnostic only) | PASS |

**Why d:** zero capabilities is a smaller container risk than granting `SYS_ADMIN`, the
broadest capability Linux has. Giving up Chromium's own sandbox is acceptable here because of
what this container runs and holds:

- The input is trusted: forms our own deterministic compiler generated, not arbitrary web content.
- The container is offline (`--network none`).
- It runs as non-root (uid 1000) with a read-only root filesystem and a read-only `/project`.
- It holds no AWS credentials, no secrets and no Docker socket.

**Fallback:** variant b, if `--no-sandbox` ever becomes a problem. It keeps Chromium's sandbox
but needs four capabilities: remove the preload below and add them in `verifyArgs`
(`runner/launch-build.ts`).

**How it's applied:** neither R5's specs nor R6's verifier pass launch args to the harness, and
R7 doesn't change their packages. The image's `/harness-no-sandbox.cjs` is preloaded with
`node --require` and adds `--no-sandbox` whenever a harness starts. `run-verify.sh` does this
for the verifier, and scripts 21 and 25 do it through `NODE_OPTIONS`.
