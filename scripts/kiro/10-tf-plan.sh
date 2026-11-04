#!/usr/bin/env bash
# Runs on the Kiro workspace (x86_64, has AWS creds + Terraform). Init + plan
# only. Never applies. Safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform"
PLAN_FILE="$TF_DIR/tfplan.out"

[ -n "${TF_VAR_alarm_email:-}" ] || { echo "RESULT: FAIL set TF_VAR_alarm_email first"; exit 1; }

echo "== 10-tf-plan: terraform init =="
cd "$TF_DIR"
terraform init -input=false

echo "== 10-tf-plan: terraform validate =="
terraform validate

echo "== 10-tf-plan: terraform plan (saved to $PLAN_FILE) =="
if terraform plan -input=false -out="$PLAN_FILE"; then
  echo "== 10-tf-plan: resource summary =="
  terraform show -no-color "$PLAN_FILE" | grep -E '^(  # |Plan:)' || true
  echo "RESULT: PASS"
else
  echo "RESULT: FAIL terraform plan failed (see output above)"
  exit 1
fi
