#!/usr/bin/env bash
# Runs scripts/seed-users.sh against the just-applied pool, then verifies each
# of the 5 demo users landed in the right Cognito group.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform"

POOL_ID="$(terraform -chdir="$TF_DIR" output -raw cognito_user_pool_id)"
export COGNITO_USER_POOL_ID="$POOL_ID"

echo "== 12-seed-users: seeding demo users in pool $POOL_ID =="
"$REPO_ROOT/scripts/seed-users.sh"

echo "== 12-seed-users: verifying group membership =="
fail=0
for group in po service_designer clinician developer release_approver; do
  email="demo.${group}@cht-nocode.example"
  got="$(aws cognito-idp admin-list-groups-for-user \
    --user-pool-id "$POOL_ID" --username "$email" \
    --query 'Groups[].GroupName' --output text)"
  if [ "$got" = "$group" ]; then
    echo "  $email -> $got (ok)"
  else
    echo "  $email -> '$got' (expected $group)"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "RESULT: PASS all 5 demo users in the right group"
else
  echo "RESULT: FAIL group mismatch, see output above"
  exit 1
fi
