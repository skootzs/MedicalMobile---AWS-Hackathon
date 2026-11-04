#!/usr/bin/env bash
# Destroys everything this Terraform created. Terraform shows the plan and asks for
# confirmation. Without --delete-artifacts, a bucket with anything in it stops the teardown
# before any resource is touched.
#
# Requires: Terraform, AWS CLI, Python 3, and credentials for the hackathon account.
set -euo pipefail

usage() {
  echo "Usage: $0 [--delete-artifacts]" >&2
  echo "  --delete-artifacts  permanently delete every object version in the artifact bucket" >&2
  exit 2
}

DELETE_ARTIFACTS=no
case "${1:-}" in
  "") ;;
  --delete-artifacts) DELETE_ARTIFACTS=yes ;;
  *) usage ;;
esac
[ "$#" -le 1 ] || usage

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform"
BUCKET="$(terraform -chdir="$TF_DIR" output -raw artifact_bucket)"
BATCH_FILE="$(mktemp)"
trap 'rm -f "$BATCH_FILE"' EXIT

# Writes up to 500 object versions and delete markers to BATCH_FILE, and prints the count.
next_batch() {
  # shellcheck disable=SC2016 # the backticks are JMESPath, not a command
  aws s3api list-object-versions --bucket "$BUCKET" --max-items 500 --output json \
    --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}, Quiet: `true`}' > "$BATCH_FILE"
  python3 -c 'import json, sys; print(len(json.load(open(sys.argv[1]))["Objects"] or []))' "$BATCH_FILE"
}

count="$(next_batch)"
if [ "$count" -gt 0 ] && [ "$DELETE_ARTIFACTS" = no ]; then
  echo "Bucket $BUCKET still holds artifacts, including build and release evidence."
  echo "RESULT: FAIL nothing was destroyed. Rerun with --delete-artifacts to delete them permanently"
  exit 1
fi

if [ "$count" -gt 0 ]; then
  echo "This permanently deletes every object version in $BUCKET. It can't be undone."
  read -r -p "Type the bucket name to confirm: " answer
  [ "$answer" = "$BUCKET" ] || { echo "RESULT: FAIL confirmation didn't match, nothing was deleted"; exit 1; }
  while [ "$count" -gt 0 ]; do
    aws s3api delete-objects --bucket "$BUCKET" --delete "file://$BATCH_FILE" > /dev/null
    echo "Deleted $count object versions"
    count="$(next_batch)"
  done
fi

echo "== teardown: terraform destroy =="
terraform -chdir="$TF_DIR" destroy

echo "RESULT: PASS infrastructure destroyed"
