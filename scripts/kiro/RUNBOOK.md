# Kiro runbook

Copy-paste prompt for Kiro's agent: see [`KIRO_PROMPT.md`](./KIRO_PROMPT.md).

These scripts run on the Kiro workspace (x86_64 Amazon Linux, hackathon AWS
credentials, Docker, git). They do not run on Srithan's Mac (ARM, no AWS
access). Each script is safe to re-run, prints a final `RESULT: PASS` or
`RESULT: FAIL <reason>` line, and never destroys anything unless its name
says so.

More scripts are appended here as later commits land (runner deploy, etc).
This list currently covers Commit 3 (Terraform core) and Commit 4 (build
pipeline images).

| # | Script | What it does | Prerequisites | Expected output | On failure | Approval needed? |
|---|---|---|---|---|---|---|
| 10 | `10-tf-plan.sh` | `terraform init` + `validate` + `plan`, saves the plan to `infra/terraform/tfplan.out`, prints a resource summary | AWS credentials in the Kiro workspace env; Terraform installed (install if missing) | `RESULT: PASS` + a `Plan: N to add, 0 to change, 0 to destroy` line | Report the `RESULT: FAIL` line and the terraform error above it; don't retry blindly | No |
| 11 | `11-tf-apply.sh` | Applies **only** the plan file saved by step 10 (never re-plans). Includes the Bedrock PII guardrail (`bedrock-guardrail.tf`) — check `terraform output bedrock_guardrail_id` / `bedrock_guardrail_version` after apply and set them in the real `.env` | Step 10 succeeded and the plan file still exists; Srithan has reviewed the plan | `RESULT: PASS` + `terraform output` | Report the `RESULT: FAIL` line; leave state as-is for Srithan to inspect | **Yes — always.** Do not run until Srithan explicitly approves the plan from step 10. |
| 12 | `12-seed-users.sh` | Runs `scripts/seed-users.sh` against the pool from step 11's outputs, then checks each of the 5 demo users is in the right Cognito group | Step 11 applied successfully | `RESULT: PASS all 5 demo users in the right group` | Report the `RESULT: FAIL` line and which user/group mismatched | No (creates demo users only, not real infra changes) |
| 20 | `20-build-image.sh` | Builds `BUILD_IMAGE` (`build-image/Dockerfile`, `FROM medicmobile/cht-app-ide:v6.6.1`) on x86_64; surfaces the python3/xsltproc/node version checks baked into the build and confirms the Chromium smoke test passed | Docker on the Kiro workspace | `RESULT: PASS built ...` | Report the `RESULT: FAIL` line + the build log tail; if a version check genuinely regressed (not just this script being wrong), stop and ask Srithan | No |
| 21 | `21-cht-core-reference-tests.sh` | R6's check: clones `medic/cht-core`, runs `config/default`'s `npm run test-unit` (includes the Chromium-backed form tests) inside `BUILD_IMAGE` with `--network none` | Step 20 succeeded; network access for the initial `npm ci` only (the test run itself is offline) | `RESULT: PASS ...; Chromium: yes ...` | Report the `RESULT: FAIL` line + log tail | No |
| 22 | `22-check-reference-compiler.sh` | R5's check: `git worktree add` the `compiler` branch pinned at `b2c5fb1`, runs his `reference/check_reference.sh` + `npm run test:integration` (`REQUIRE_CHT=1`) inside `medicmobile/cht-app-ide:v6.6.1` | Docker; network (clones/fetches, `npm ci`, `pip3 install openpyxl` for the reference script only — not baked into `BUILD_IMAGE`) | `RESULT: PASS check_reference.sh and integration test passed at b2c5fb1` | Report the `RESULT: FAIL` line + log tail; do not silently move the pin past `b2c5fb1` without Srithan/R5 | No |
| 23 | `23-compile-smoke-test.sh` | R5's other check: `git worktree add` the same pinned compiler commit, runs his CLI directly in pinned `COMPILE_IMAGE` (`node:22.23.4-slim`) with `--network none --read-only` against his own `test/fixtures/child-cough.logic.json` | Docker | `RESULT: PASS compiled against child-cough fixture, compile-manifest.json written` | Report the `RESULT: FAIL` line + log tail | No |
| 24 | `24-setup-cht.sh` | Non-interactive CHT setup on the CHT host via `aws ssm send-command`: feeds cht-core's Docker Helper (`cht-docker-compose.sh`) its 3 first-run prompts (`y` / `Y` latest / project name `cht-nocode`), polls the SSM command, prints the resulting `local-ip.medicmobile.org` URL | `11-tf-apply.sh` applied (CHT host exists, bootstrap cloned cht-core into `~/cht-hackathon`); AWS creds with `ssm:SendCommand`/`ssm:GetCommandInvocation` on the CHT host instance | `RESULT: PASS CHT instance 'cht-nocode' is up on <instance-id>` + the printed URL | Report the `RESULT: FAIL` line + remote stdout/stderr from the script's output | No (only acts on the CHT host instance this Terraform creates, never the Kiro workspace instance) |

**Hard rule for every script here and future additions:** never target EC2
instance `i-039648f03266104f5` (the Kiro workspace itself) or anything this
Terraform didn't create. The nightly stop scheduler in `scheduler.tf` is
already scoped to only the two instances this config creates.
