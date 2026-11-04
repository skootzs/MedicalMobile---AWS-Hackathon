#!/usr/bin/env bash
# Runs from the Kiro workspace. Uses `aws ssm send-command` to set up a CHT
# instance on the CHT host non-interactively via cht-core's Docker Helper
# (scripts/docker-helper/cht-docker-compose.sh, cloned into ~/cht-hackathon
# by infra/terraform/bootstrap/cht-host.sh).
#
# The helper is interactive; its exact prompt sequence for a first-ever run
# (confirmed by reading cht-docker-compose.sh) is:
#   1. "Would you like to initialize a new project [y/N]? "
#   2. "Do you want to run the latest CHT Core version (<ver>) [Y/n]? "
#   3. "How do you want to name the project? "
# Answers below: y / Y (latest) / cht-nocode. No further prompts fire once
# the project name is set. It then waits (up to 5 min, its own internal
# retry loop) for nginx to come up and installs a local-ip.medicmobile.org
# TLS cert, so give the SSM command plenty of timeout headroom.
set -euo pipefail

CHT_HOST_INSTANCE_ID="${CHT_HOST_INSTANCE_ID:-i-0e62ce13ee729cc6d}"
PROJECT_NAME="${PROJECT_NAME:-cht-nocode}"
SSM_TIMEOUT_SECONDS="${SSM_TIMEOUT_SECONDS:-1800}"

echo "== 24-setup-cht: never targets the Kiro workspace instance (i-039648f03266104f5) =="
if [ "$CHT_HOST_INSTANCE_ID" = "i-039648f03266104f5" ]; then
  echo "RESULT: FAIL refusing to target the Kiro workspace instance"
  exit 1
fi

PARAMS_FILE="$(mktemp)"
trap 'rm -f "$PARAMS_FILE"' EXIT
python3 - "$PARAMS_FILE" "$PROJECT_NAME" <<'PYEOF'
import json, sys
params_file, project_name = sys.argv[1], sys.argv[2]
script = f"""set -e
cd /home/ubuntu/cht-hackathon/cht-core/scripts/docker-helper
printf 'y\\nY\\n{project_name}\\n' | ./cht-docker-compose.sh
"""
with open(params_file, "w") as f:
    json.dump({"commands": [script]}, f)
PYEOF

echo "== 24-setup-cht: aws ssm send-command on $CHT_HOST_INSTANCE_ID (project: $PROJECT_NAME) =="
COMMAND_ID="$(aws ssm send-command \
  --instance-ids "$CHT_HOST_INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --timeout-seconds "$SSM_TIMEOUT_SECONDS" \
  --parameters "file://$PARAMS_FILE" \
  --query 'Command.CommandId' --output text)"

echo "SSM command: $COMMAND_ID"
echo "== 24-setup-cht: polling until the command finishes (timeout ${SSM_TIMEOUT_SECONDS}s) =="

status="InProgress"
elapsed=0
poll_interval=15
while [ "$status" = "InProgress" ] || [ "$status" = "Pending" ]; do
  if [ "$elapsed" -ge "$SSM_TIMEOUT_SECONDS" ]; then
    echo "RESULT: FAIL local poll timeout waiting on SSM command $COMMAND_ID"
    exit 1
  fi
  sleep "$poll_interval"
  elapsed=$((elapsed + poll_interval))
  status="$(aws ssm get-command-invocation \
    --command-id "$COMMAND_ID" --instance-id "$CHT_HOST_INSTANCE_ID" \
    --query 'Status' --output text 2>/dev/null || echo "InProgress")"
  echo "  [$elapsed s] status: $status"
done

OUTPUT="$(aws ssm get-command-invocation \
  --command-id "$COMMAND_ID" --instance-id "$CHT_HOST_INSTANCE_ID" \
  --query 'StandardOutputContent' --output text)"
ERROR_OUTPUT="$(aws ssm get-command-invocation \
  --command-id "$COMMAND_ID" --instance-id "$CHT_HOST_INSTANCE_ID" \
  --query 'StandardErrorContent' --output text)"

echo "== 24-setup-cht: remote stdout =="
echo "$OUTPUT"

if [ "$status" = "Success" ]; then
  CHT_URL="$(echo "$OUTPUT" | grep -oE 'https://[A-Za-z0-9.-]+\.local-ip\.medicmobile\.org:[0-9]+' | head -1 || true)"
  if [ -n "$CHT_URL" ]; then
    echo "CHT URL: $CHT_URL/ (admin login printed above, never logged separately)"
  else
    echo "WARNING: command succeeded but no CHT URL line was found in its output"
  fi
  echo "RESULT: PASS CHT instance '$PROJECT_NAME' is up on $CHT_HOST_INSTANCE_ID"
else
  echo "== 24-setup-cht: remote stderr =="
  echo "$ERROR_OUTPUT"
  echo "RESULT: FAIL SSM command ended with status $status"
  exit 1
fi
