#!/usr/bin/env bash
# Builds and pushes the runner and BUILD_IMAGE, installs the runner on the app host over SSM,
# and confirms it's polling the jobs queue. Safe to re-run. Acts only on the app host this
# Terraform created, and starts it if the nightly schedule stopped it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform"
KIRO_INSTANCE="i-039648f03266104f5"
AWS_REGION="${AWS_REGION:-us-west-2}"
LOCAL_BUILD_IMAGE="${BUILD_IMAGE_TAG:-cht-nocode/build-image:latest}"
TAG="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"

tf() { terraform -chdir="$TF_DIR" output -raw "$1"; }
fail() { echo "RESULT: FAIL $1"; exit 1; }
repo_url() { terraform -chdir="$TF_DIR" output -json ecr_repository_urls | python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }

APP_HOST="$(tf app_host_instance_id)"
[ "$APP_HOST" != "$KIRO_INSTANCE" ] || fail "refusing to target the Kiro workspace instance"
WORKER_REPO="$(repo_url worker)"
BUILD_REPO="$(repo_url build-image)"
REGISTRY="${WORKER_REPO%%/*}"
WORKER_IMAGE="$WORKER_REPO:$TAG"
BUILD_IMAGE="$BUILD_REPO:$TAG"

docker image inspect "$LOCAL_BUILD_IMAGE" >/dev/null 2>&1 || fail "$LOCAL_BUILD_IMAGE not found, run 20-build-image.sh first"

# Repos have immutable tags, so an existing tag is already the right image.
image_in_ecr() {
  aws ecr describe-images --region "$AWS_REGION" --repository-name "${1#*/}" --image-ids "imageTag=$TAG" >/dev/null 2>&1
}

echo "== 31-deploy-runner: images at tag $TAG =="
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"
if image_in_ecr "$BUILD_REPO"; then
  echo "$BUILD_IMAGE already in ECR"
else
  docker tag "$LOCAL_BUILD_IMAGE" "$BUILD_IMAGE"
  docker push "$BUILD_IMAGE" || fail "could not push $BUILD_IMAGE"
fi
if image_in_ecr "$WORKER_REPO"; then
  echo "$WORKER_IMAGE already in ECR"
else
  "$REPO_ROOT/scripts/build-runner-image.sh" "$WORKER_IMAGE" || fail "could not build the runner image"
  docker push "$WORKER_IMAGE" || fail "could not push $WORKER_IMAGE"
fi

echo "== 31-deploy-runner: app host $APP_HOST =="
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

# Usage: run_on_host <label> <shell script>. Prints output; returns non-zero if it failed.
run_on_host() {
  local label="$1" script="$2" params command_id status="Pending" elapsed=0
  params="$(mktemp)"
  python3 - "$params" "$script" <<'PY'
import json, sys
with open(sys.argv[1], "w") as f:
    json.dump({"commands": [sys.argv[2]]}, f)
PY
  command_id="$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$APP_HOST" \
    --document-name AWS-RunShellScript --timeout-seconds 1200 --comment "31-deploy-runner $label" \
    --parameters "file://$params" --query 'Command.CommandId' --output text)"
  rm -f "$params"
  while [ "$status" = "Pending" ] || [ "$status" = "InProgress" ] || [ "$status" = "Delayed" ]; do
    [ "$elapsed" -lt 1200 ] || { echo "Timed out waiting for SSM command $command_id"; return 1; }
    sleep 10
    elapsed=$((elapsed + 10))
    status="$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" \
      --instance-id "$APP_HOST" --query Status --output text 2>/dev/null || echo Pending)"
  done
  aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$APP_HOST" \
    --query '[StandardOutputContent,StandardErrorContent]' --output text
  [ "$status" = "Success" ]
}

echo "== 31-deploy-runner: checking the host's tools =="
# shellcheck disable=SC2016 # expands on the host
run_on_host preflight '
missing=""
for tool in docker node aws; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
cloud-init status || true
if [ -n "$missing" ]; then
  echo "MISSING TOOLS:$missing"
  tail -n 30 /var/log/cloud-init-output.log
  exit 1
fi
node --version
docker --version
[ -f /etc/cht-nocode/env ] || { echo "MISSING /etc/cht-nocode/env"; exit 1; }
' || fail "the app host bootstrap did not finish (tools or env missing), see output above"

echo "== 31-deploy-runner: installing the runner =="
# Older hosts' env files predate these values, and user data doesn't rerun on them.
env_lines="JOB_EVENTS_QUEUE_URL=$(tf job_events_queue_url)
JOB_EVENTS_DLQ_URL=$(tf job_events_dlq_url)
CHT_SECRET_NAME=$(tf cht_secret_name)
BEDROCK_GUARDRAIL_ID=$(tf bedrock_guardrail_id)
BEDROCK_GUARDRAIL_VERSION=$(tf bedrock_guardrail_version)"
run_on_host install "
set -eu
while IFS= read -r line; do
  grep -q \"^\${line%%=*}=\" /etc/cht-nocode/env || echo \"\$line\" >> /etc/cht-nocode/env
done <<'ENV'
$env_lines
ENV
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $REGISTRY
docker pull $WORKER_IMAGE
container=\$(docker create $WORKER_IMAGE)
docker cp \"\$container:/opt/cht-nocode-bundle/install-runner.sh\" /tmp/install-runner.sh
docker rm \"\$container\"
sh /tmp/install-runner.sh $WORKER_IMAGE $BUILD_IMAGE
" || fail "runner install failed, see output above"

echo "== 31-deploy-runner: confirming it's polling =="
# A receive call waits up to 20s, and a failed one logs 'runner loop error' (for example,
# when IAM denies it). So a clean log after 45s means receives are succeeding.
# shellcheck disable=SC2016 # expands on the host
run_on_host verify '
sleep 45
systemctl is-active cht-build-runner
log="$(cat /var/log/cht-nocode/runner.log)"
echo "$log" | tail -n 20
echo "$log" | grep -q "runner started" || { echo "No runner started line"; exit 1; }
if echo "$log" | grep -q "runner loop error"; then echo "Runner loop errors found"; exit 1; fi
' || fail "the runner is not polling cleanly, see output above"

echo "== 31-deploy-runner: confirming logs reach CloudWatch =="
LOG_GROUP="$(tf log_group_name)"
SINCE_MS="$(( ($(date +%s) - 900) * 1000 ))"
shipped=0
for _ in $(seq 1 18); do
  shipped="$(aws logs filter-log-events --region "$AWS_REGION" --log-group-name "$LOG_GROUP" \
    --log-stream-name-prefix runner- --start-time "$SINCE_MS" --filter-pattern '"runner started"' \
    --query 'length(events)' --output text)"
  [ "$shipped" != "0" ] && break
  sleep 10
done
[ "$shipped" != "0" ] || fail "runner logs did not reach $LOG_GROUP within 3 minutes"
matches="$(aws logs test-metric-filter --region "$AWS_REGION" --filter-pattern '"level=error"' \
  --log-event-messages 'level=error runner loop error' 'level=info runner started' \
  --query 'length(matches)' --output text)"
[ "$matches" = "1" ] || fail "the error alarm's filter pattern matched $matches of 2 test lines, expected 1"

echo "RESULT: PASS runner $TAG polling on $APP_HOST, logs reaching $LOG_GROUP"
