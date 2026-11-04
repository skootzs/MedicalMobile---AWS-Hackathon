#!/usr/bin/env bash
# Creates the cht-nocode table against DynamoDB Local (docker-compose.test.yml),
# matching infra/terraform/dynamodb.tf exactly: pk/sk keys, GSI1 (jobs per
# request), GSI2 (reviewer inboxes), stream NEW_AND_OLD_IMAGES.
#
# Used by runner tests (section 7) and CI's DynamoDB Local service container
# (section 13). Safe to re-run: skips creation if the table already exists.
set -euo pipefail

ENDPOINT="${DYNAMODB_LOCAL_ENDPOINT:-http://localhost:8000}"
TABLE_NAME="${DDB_TABLE:-cht-nocode}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-local}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-local}"
export AWS_DEFAULT_REGION="${AWS_REGION:-us-west-2}"

if aws dynamodb describe-table --endpoint-url "$ENDPOINT" --table-name "$TABLE_NAME" >/dev/null 2>&1; then
  echo "RESULT: PASS table $TABLE_NAME already exists"
  exit 0
fi

aws dynamodb create-table \
  --endpoint-url "$ENDPOINT" \
  --table-name "$TABLE_NAME" \
  --attribute-definitions \
    AttributeName=pk,AttributeType=S \
    AttributeName=sk,AttributeType=S \
    AttributeName=gsi1pk,AttributeType=S \
    AttributeName=gsi1sk,AttributeType=S \
    AttributeName=gsi2pk,AttributeType=S \
    AttributeName=gsi2sk,AttributeType=S \
  --key-schema \
    AttributeName=pk,KeyType=HASH \
    AttributeName=sk,KeyType=RANGE \
  --global-secondary-indexes \
    '[
      {
        "IndexName": "GSI1",
        "KeySchema": [
          { "AttributeName": "gsi1pk", "KeyType": "HASH" },
          { "AttributeName": "gsi1sk", "KeyType": "RANGE" }
        ],
        "Projection": { "ProjectionType": "ALL" }
      },
      {
        "IndexName": "GSI2",
        "KeySchema": [
          { "AttributeName": "gsi2pk", "KeyType": "HASH" },
          { "AttributeName": "gsi2sk", "KeyType": "RANGE" }
        ],
        "Projection": { "ProjectionType": "ALL" }
      }
    ]' \
  --billing-mode PAY_PER_REQUEST \
  --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
  >/dev/null

aws dynamodb wait table-exists --endpoint-url "$ENDPOINT" --table-name "$TABLE_NAME"

echo "RESULT: PASS created $TABLE_NAME with GSI1, GSI2, and a stream"
