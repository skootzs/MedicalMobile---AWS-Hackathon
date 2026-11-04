#!/usr/bin/env bash
# Creates one demo user per Cognito group. Temporary passwords are printed
# once to stdout and never written to disk or committed.
#
# Requires: AWS CLI, credentials for the hackathon account, and
# COGNITO_USER_POOL_ID (read from `terraform output` if not already set).
set -euo pipefail

usage() {
  echo "Usage: COGNITO_USER_POOL_ID=<pool-id> $0" >&2
  exit 1
}

if [ -z "${COGNITO_USER_POOL_ID:-}" ]; then
  if command -v terraform >/dev/null 2>&1 && [ -d "$(dirname "$0")/../infra/terraform" ]; then
    COGNITO_USER_POOL_ID="$(terraform -chdir="$(dirname "$0")/../infra/terraform" output -raw cognito_user_pool_id 2>/dev/null || true)"
  fi
fi

[ -n "${COGNITO_USER_POOL_ID:-}" ] || usage

groups="po service_designer clinician developer release_approver"

for group in $groups; do
  email="demo.${group}@cht-nocode.example"
  password="$(openssl rand -base64 18)Aa1!"

  echo "== ${group} =="
  aws cognito-idp admin-create-user \
    --user-pool-id "$COGNITO_USER_POOL_ID" \
    --username "$email" \
    --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
    --temporary-password "$password" \
    --message-action SUPPRESS \
    >/dev/null

  aws cognito-idp admin-add-user-to-group \
    --user-pool-id "$COGNITO_USER_POOL_ID" \
    --username "$email" \
    --group-name "$group"

  echo "  username: $email"
  echo "  temporary password: $password"
  echo "  (change required on first sign-in; not stored anywhere)"
done

echo "RESULT: PASS - seeded ${groups// /, }"
