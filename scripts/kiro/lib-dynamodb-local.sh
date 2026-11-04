#!/usr/bin/env bash
# Sourced by Kiro scripts that need DynamoDB Local. Uses Compose where it's installed, and
# plain docker run where it isn't. Keep the image and command in step with
# docker-compose.test.yml.
DYNAMODB_LOCAL_CONTAINER="cht-nocode-dynamodb-local"

# Usage: start_dynamodb_local <repo-root>
start_dynamodb_local() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$1/docker-compose.test.yml" up -d
  else
    docker rm -f "$DYNAMODB_LOCAL_CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$DYNAMODB_LOCAL_CONTAINER" -p 8000:8000 \
      amazon/dynamodb-local:2.5.3 -jar DynamoDBLocal.jar -inMemory -sharedDb
  fi
  sleep 3
}

# Usage: stop_dynamodb_local <repo-root>
stop_dynamodb_local() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$1/docker-compose.test.yml" down -v >/dev/null 2>&1 || true
  else
    docker rm -f "$DYNAMODB_LOCAL_CONTAINER" >/dev/null 2>&1 || true
  fi
}
