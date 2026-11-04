#!/usr/bin/env bash
# Writes the gitignored repo-root .env from live `terraform output` values. IDs and URLs
# only, no credentials. Run after 11-tf-apply.sh; safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform"
ENV_FILE="$REPO_ROOT/.env"

tf() { terraform -chdir="$TF_DIR" output -raw "$1"; }

echo "== 13-write-env: reading terraform output =="
umask 077
{
  echo "AWS_REGION=us-west-2"
  echo "PROJECT_TAG=cht-nocode"
  echo "ARTIFACT_BUCKET=$(tf artifact_bucket)"
  echo "DDB_TABLE=$(tf dynamodb_table_name)"
  echo "JOBS_QUEUE_URL=$(tf jobs_queue_url)"
  echo "JOBS_DLQ_URL=$(tf jobs_dlq_url)"
  echo "COGNITO_USER_POOL_ID=$(tf cognito_user_pool_id)"
  echo "COGNITO_CLIENT_ID=$(tf cognito_user_pool_client_id)"
  echo "CHT_SECRET_NAME=$(tf cht_secret_name)"
  echo "BEDROCK_GUARDRAIL_ID=$(tf bedrock_guardrail_id)"
  echo "BEDROCK_GUARDRAIL_VERSION=$(tf bedrock_guardrail_version)"
} > "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"

if git -C "$REPO_ROOT" check-ignore -q .env; then
  echo "RESULT: PASS wrote $ENV_FILE (gitignored, mode 600)"
else
  echo "RESULT: FAIL $ENV_FILE is not gitignored"
  exit 1
fi
