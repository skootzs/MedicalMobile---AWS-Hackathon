#!/usr/bin/env bash
# Finishes the app host's first-boot setup if it never completed, which happened when the
# security group blocked apt's port 80. Does nothing if the tools are already there. It reruns
# the user data stored on the instance over SSM. Acts only on the app host this Terraform created.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform"
KIRO_INSTANCE="i-039648f03266104f5"
AWS_REGION="${AWS_REGION:-us-west-2}"

fail() { echo "RESULT: FAIL $1"; exit 1; }

APP_HOST="$(terraform -chdir="$TF_DIR" output -raw app_host_instance_id)"
[ "$APP_HOST" != "$KIRO_INSTANCE" ] || fail "refusing to target the Kiro workspace instance"

state="$(aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$APP_HOST" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)"
if [ "$state" != "running" ]; then
  echo "Host is $state, starting it"
  aws ec2 start-instances --region "$AWS_REGION" --instance-ids "$APP_HOST" >/dev/null
  aws ec2 wait instance-running --region "$AWS_REGION" --instance-ids "$APP_HOST"
fi
ping="unknown"
for _ in $(seq 1 30); do
  ping="$(aws ssm describe-instance-information --region "$AWS_REGION" \
    --filters "Key=InstanceIds,Values=$APP_HOST" --query 'InstanceInformationList[0].PingStatus' --output text)"
  [ "$ping" = "Online" ] && break
  sleep 10
done
[ "$ping" = "Online" ] || fail "app host is not online in SSM (status: $ping)"

USER_DATA="$(aws ec2 describe-instance-attribute --region "$AWS_REGION" --instance-id "$APP_HOST" \
  --attribute userData --query 'UserData.Value' --output text)"
[ -n "$USER_DATA" ] && [ "$USER_DATA" != "None" ] || fail "the instance has no stored user data"

PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
python3 - "$PARAMS" "$USER_DATA" <<'PY'
import json, sys
script = f"""
if command -v docker >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && command -v aws >/dev/null 2>&1 && [ -f /etc/cht-nocode/env ]; then
  echo "Bootstrap already complete"
  exit 0
fi
echo "Rerunning first-boot setup"
echo '{sys.argv[2]}' | base64 -d > /tmp/cht-nocode-bootstrap.sh
bash /tmp/cht-nocode-bootstrap.sh
"""
with open(sys.argv[1], "w") as f:
    json.dump({"commands": [script]}, f)
PY

echo "== 14-bootstrap-app-host: $APP_HOST =="
COMMAND_ID="$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$APP_HOST" \
  --document-name AWS-RunShellScript --timeout-seconds 1500 --comment "14-bootstrap-app-host" \
  --parameters "file://$PARAMS" --query 'Command.CommandId' --output text)"

status="Pending"
elapsed=0
while [ "$status" = "Pending" ] || [ "$status" = "InProgress" ] || [ "$status" = "Delayed" ]; do
  [ "$elapsed" -lt 1500 ] || fail "timed out waiting for SSM command $COMMAND_ID"
  sleep 15
  elapsed=$((elapsed + 15))
  status="$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$COMMAND_ID" \
    --instance-id "$APP_HOST" --query Status --output text 2>/dev/null || echo Pending)"
done
aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$COMMAND_ID" --instance-id "$APP_HOST" \
  --query '[StandardOutputContent,StandardErrorContent]' --output text | tail -n 30

[ "$status" = "Success" ] || fail "first-boot setup ended with status $status, see output above"
echo "RESULT: PASS app host bootstrap complete on $APP_HOST"
