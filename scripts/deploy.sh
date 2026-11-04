#!/usr/bin/env bash
# Deploys the infrastructure: terraform apply, demo users, and the local .env. Safe to re-run.
# Terraform shows the plan and asks for confirmation. App-level deploys belong to the
# integrator (docs/integration-handoff.md); the runner has scripts/kiro/31-deploy-runner.sh.
#
# Requires: Terraform, AWS CLI, Python 3, credentials for the hackathon account, and
# TF_VAR_alarm_email set to the address for the error alarm.
set -euo pipefail

usage() {
  echo "Usage: $0" >&2
  exit 2
}
[ "$#" -eq 0 ] || usage

[ -n "${TF_VAR_alarm_email:-}" ] || { echo "RESULT: FAIL set TF_VAR_alarm_email first"; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform"

echo "== deploy: terraform apply =="
terraform -chdir="$TF_DIR" init -input=false
terraform -chdir="$TF_DIR" apply

echo "== deploy: demo users =="
COGNITO_USER_POOL_ID="$(terraform -chdir="$TF_DIR" output -raw cognito_user_pool_id)" "$REPO_ROOT/scripts/seed-users.sh"

echo "== deploy: local .env =="
"$REPO_ROOT/scripts/kiro/13-write-env.sh"

APP_HOST="$(terraform -chdir="$TF_DIR" output -raw app_host_instance_id)"
echo
echo "Set the CHT login in Secrets Manager if it's new: $(terraform -chdir="$TF_DIR" output -raw cht_secret_name)"
echo "Connect to the app host: aws ssm start-session --target $APP_HOST"
echo "RESULT: PASS infrastructure deployed"
