#!/usr/bin/env bash
# Checks the outbox and job-events Pipes against the live table and queues. Writes test
# items under JOB#smoke-*, and deletes only those items and its own messages.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform"
tf() { terraform -chdir="$TF_DIR" output -raw "$1"; }
fail() { echo "RESULT: FAIL $1"; exit 1; }

TABLE="$(tf dynamodb_table_name)"
JOBS_URL="$(tf jobs_queue_url)"
EVENTS_URL="$(tf job_events_queue_url)"
RUN_ID="$(date +%s)-$$"
JOB="smoke-$RUN_ID"
DRAFT_JOB="smoke-draft-$RUN_ID"
PIPE_WAIT_SECONDS="${PIPE_WAIT_SECONDS:-120}"

delete_item() {
  aws dynamodb delete-item --table-name "$TABLE" \
    --key "{\"pk\":{\"S\":\"JOB#$1\"},\"sk\":{\"S\":\"$2\"}}" >/dev/null 2>&1 || true
}
cleanup() {
  delete_item "$JOB" META
  delete_item "$JOB" OUTBOX
  delete_item "$DRAFT_JOB" OUTBOX
}
trap cleanup EXIT

# Receiving a real job counts toward its DLQ limit, so only run against empty queues.
for url in "$JOBS_URL" "$EVENTS_URL"; do
  counts="$(aws sqs get-queue-attributes --queue-url "$url" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
    --query 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible]' --output text)"
  [ "$(echo "$counts" | tr -d '[:space:]')" = "00" ] || fail "queue not empty ($url: $counts), not touching real jobs"
done

# Sets BODY to the next message, or empty after <seconds>. Deletes smoke messages and
# fails on anything else, returning it to the queue first.
next_message() {
  local url="$1" deadline=$((SECONDS + $2)) handle
  BODY=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    IFS=$'\t' read -r handle BODY < <(aws sqs receive-message --queue-url "$url" --wait-time-seconds 10 \
      --max-number-of-messages 1 --query 'Messages[0].[ReceiptHandle,Body]' --output text)
    if [ "$handle" = "None" ] || [ -z "$handle" ]; then
      BODY=""
      continue
    fi
    case "$BODY" in
      *smoke-*) aws sqs delete-message --queue-url "$url" --receipt-handle "$handle"; return 0 ;;
      *)
        aws sqs change-message-visibility --queue-url "$url" --receipt-handle "$handle" --visibility-timeout 0
        fail "a real message arrived during the smoke test, stopping"
        ;;
    esac
  done
}

put_outbox() {
  aws dynamodb put-item --table-name "$TABLE" --item "{
    \"pk\":{\"S\":\"JOB#$1\"},\"sk\":{\"S\":\"OUTBOX\"},\"jobId\":{\"S\":\"$1\"},\"jobType\":{\"S\":\"$2\"},
    \"payload\":{\"M\":{\"jobId\":{\"S\":\"$1\"},\"jobType\":{\"S\":\"$2\"},\"revision\":{\"N\":\"1\"}}}}"
}
set_status() {
  aws dynamodb update-item --table-name "$TABLE" \
    --key "{\"pk\":{\"S\":\"JOB#$JOB\"},\"sk\":{\"S\":\"META\"}}" \
    --update-expression 'SET #s = :s, leaseUntil = :l' --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{\":s\":{\"S\":\"$1\"},\":l\":{\"N\":\"$2\"}}"
}

echo "== 30-pipes-smoke: outbox Pipe (run $RUN_ID) =="
put_outbox "$DRAFT_JOB" DRAFT_LOGIC
put_outbox "$JOB" COMPILE_LOGIC
next_message "$JOBS_URL" "$PIPE_WAIT_SECONDS"
[ -n "$BODY" ] || fail "no outbox message within ${PIPE_WAIT_SECONDS}s, check the pipe's state and role"
echo "jobs queue body: $BODY"
python3 - "$BODY" "$JOB" <<'PY' || fail "outbox message is not the DynamoDB JSON payload"
import json, sys
body = json.loads(sys.argv[1])
assert body["M"]["jobId"]["S"] == sys.argv[2], body
assert body["M"]["revision"]["N"] == "1", body
PY

echo "== 30-pipes-smoke: DRAFT_LOGIC must stay off the jobs queue =="
next_message "$JOBS_URL" 30
[ -z "$BODY" ] || fail "unexpected jobs message: $BODY"

echo "== 30-pipes-smoke: events Pipe =="
aws dynamodb put-item --table-name "$TABLE" --item "{
  \"pk\":{\"S\":\"JOB#$JOB\"},\"sk\":{\"S\":\"META\"},\"jobId\":{\"S\":\"$JOB\"},
  \"status\":{\"S\":\"PENDING\"},\"attempt\":{\"N\":\"1\"},\"leaseUntil\":{\"N\":\"0\"}}"
set_status RUNNING 1
next_message "$EVENTS_URL" "$PIPE_WAIT_SECONDS"
[ -n "$BODY" ] || fail "no job event within ${PIPE_WAIT_SECONDS}s, check the pipe's state and role"
echo "job-events body: $BODY"
python3 - "$BODY" "$JOB" <<'PY' || fail "job event is not {jobId,status,attempt}"
import json, sys
assert json.loads(sys.argv[1]) == {"jobId": sys.argv[2], "status": "RUNNING", "attempt": 1}, sys.argv[1]
PY

echo "== 30-pipes-smoke: a same-status write must not produce an event =="
set_status RUNNING 2
next_message "$EVENTS_URL" 30
[ -z "$BODY" ] || fail "same-status write produced an event: $BODY"

echo "RESULT: PASS both Pipes deliver and filter as designed"
