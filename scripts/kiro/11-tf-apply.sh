#!/usr/bin/env bash
# Applies the exact plan saved by 10-tf-plan.sh. Never re-plans or auto-approves
# a fresh plan. APPROVAL REQUIRED before running this (see RUNBOOK.md).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform"
PLAN_FILE="$TF_DIR/tfplan.out"

if [ ! -f "$PLAN_FILE" ]; then
  echo "RESULT: FAIL no saved plan at $PLAN_FILE - run 10-tf-plan.sh first"
  exit 1
fi

echo "== 11-tf-apply: applying saved plan $PLAN_FILE =="
cd "$TF_DIR"
if terraform apply -input=false "$PLAN_FILE"; then
  echo "== 11-tf-apply: outputs =="
  terraform output
  echo "RESULT: PASS"
else
  echo "RESULT: FAIL terraform apply failed (see output above)"
  exit 1
fi
