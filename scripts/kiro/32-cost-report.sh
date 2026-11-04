#!/usr/bin/env bash
# Read-only cost evidence: spend to date from Cost Explorer, Bedrock tokens from CloudWatch,
# and tokens and spend per run. A "run" is one request in the table. Each section reports
# what it can reach, so one denied permission doesn't lose the rest.
#
# Each Cost Explorer call costs $0.01. Its data lags by about a day.
#
# Options through env: COST_START (YYYY-MM-DD, default the 1st of last month).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform"
TABLE="$(terraform -chdir="$TF_DIR" output -raw dynamodb_table_name)"
export AWS_REGION="${AWS_REGION:-us-west-2}"

python3 "$REPO_ROOT/scripts/kiro/cost_report.py" "$TABLE"
