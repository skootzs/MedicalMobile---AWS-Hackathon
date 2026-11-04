# Kiro runbook

Copy-paste prompt for Kiro's agent: see [`KIRO_PROMPT.md`](./KIRO_PROMPT.md).

These scripts run on the Kiro workspace (x86_64 Amazon Linux, hackathon AWS
credentials, Docker, git). They do not run on Srithan's Mac (ARM, no AWS
access). Each script is safe to re-run, prints a final `RESULT: PASS` or
`RESULT: FAIL <reason>` line, and never destroys anything unless its name
says so.

More scripts are appended here as later commits land (build-image checks,
reference tests, runner deploy). This list currently covers Commit 3
(Terraform core).

| # | Script | What it does | Prerequisites | Expected output | On failure | Approval needed? |
|---|---|---|---|---|---|---|
| 10 | `10-tf-plan.sh` | `terraform init` + `validate` + `plan`, saves the plan to `infra/terraform/tfplan.out`, prints a resource summary | AWS credentials in the Kiro workspace env; Terraform installed (install if missing) | `RESULT: PASS` + a `Plan: N to add, 0 to change, 0 to destroy` line | Report the `RESULT: FAIL` line and the terraform error above it; don't retry blindly | No |
| 11 | `11-tf-apply.sh` | Applies **only** the plan file saved by step 10 (never re-plans). Includes the Bedrock PII guardrail (`bedrock-guardrail.tf`) — check `terraform output bedrock_guardrail_id` / `bedrock_guardrail_version` after apply and set them in the real `.env` | Step 10 succeeded and the plan file still exists; Srithan has reviewed the plan | `RESULT: PASS` + `terraform output` | Report the `RESULT: FAIL` line; leave state as-is for Srithan to inspect | **Yes — always.** Do not run until Srithan explicitly approves the plan from step 10. |
| 12 | `12-seed-users.sh` | Runs `scripts/seed-users.sh` against the pool from step 11's outputs, then checks each of the 5 demo users is in the right Cognito group | Step 11 applied successfully | `RESULT: PASS all 5 demo users in the right group` | Report the `RESULT: FAIL` line and which user/group mismatched | No (creates demo users only, not real infra changes) |

**Hard rule for every script here and future additions:** never target EC2
instance `i-039648f03266104f5` (the Kiro workspace itself) or anything this
Terraform didn't create. The nightly stop scheduler in `scheduler.tf` is
already scoped to only the two instances this config creates.
