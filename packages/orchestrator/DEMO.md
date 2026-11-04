# Role 2 orchestrator — runnable local demo (Milestone 1)

This is the minimum runnable Role 2 backend: the existing Fastify API, workflow,
approval gates, DynamoDB adapter and durable object storage, wired through a
production composition root (`src/bootstrap.ts` + `src/main.ts`).

- **Local mode** (`MODE=local`): real DynamoDB adapter against DynamoDB Local +
  a real local-filesystem durable object store, with LOCAL/DEMO identities so
  the workflow can be demonstrated end to end. It never falls back to in-memory
  storage.
- **AWS mode** (`MODE=aws`): real DynamoDB, real immutable S3 object storage,
  and real verified Cognito (access-token) authentication. No in-memory
  fallback, no local disk, no demo identities. Startup fails closed on missing
  or invalid config. An unauthenticated `GET /health` liveness probe is served
  in both modes (`{status,mode}` only — no workflow data).

### AWS mode (Milestone 2)

```sh
cd packages/orchestrator
MODE=aws \
AWS_REGION=us-west-2 \
DDB_TABLE=cht-nocode \
ARTIFACT_BUCKET=<terraform output artifact_bucket> \
COGNITO_USER_POOL_ID=<terraform output cognito_user_pool_id> \
COGNITO_CLIENT_ID=<terraform output cognito_user_pool_client_id> \
HOST=0.0.0.0 PORT=8080 \
npm start
```

AWS mode verifies Cognito **access tokens** (signature, issuer, user pool,
client id, `token_use=access`, expiry) via `aws-jwt-verify`, derives roles from
the verified `cognito:groups` claim, and enforces request-level access from
authoritative DynamoDB state (owner, or the reviewer whose queue currently holds
the request). Nothing is trusted from the request body. It needs AWS credentials
(the EC2 instance role from R7's `iam.tf`) to reach DynamoDB/S3; the JWKS is
fetched from the user pool on the first request.

> The demo identities in `src/demo-identity.ts` are **test/local-only** and are
> never wired for AWS mode. They map fixed bearer tokens to the SAME
> Cognito-group → role mapping real users get; only token verification is faked.

## Prerequisites

- Node 22+ (verified on Node 24; `--experimental-strip-types` runs the `.ts`
  sources directly).
- Dependencies installed in isolation (no shared lockfile is created):

  ```sh
  cd packages/orchestrator
  npm install --workspaces=false --no-package-lock --ignore-scripts
  ```

- DynamoDB Local on `http://localhost:8000`:

  ```sh
  docker run --rm -p 8000:8000 amazon/dynamodb-local:latest \
    -jar DynamoDBLocal.jar -inMemory -sharedDb
  ```

## Start the demo

Create the table once (same keys/GSIs/stream as R7's `infra/terraform/dynamodb.tf`),
then start the server:

```sh
cd packages/orchestrator
MODE=local \
R2_DYNAMODB_LOCAL_ENDPOINT=http://localhost:8000 \
DDB_TABLE=cht-nocode-demo \
R2_OBJECT_DIR=/tmp/r2-demo-objects \
HOST=127.0.0.1 PORT=8099 \
npm start
```

(The table must exist first; the integration tests create their own unique
tables. For a manual run, create `cht-nocode-demo` with pk/sk + GSI1/GSI2 and a
`NEW_AND_OLD_IMAGES` stream, matching `test/helpers/dynamodb-local-fixtures.ts`.)

On success it prints:

```
[orchestrator] mode=local listening on http://127.0.0.1:8099
[orchestrator] LOCAL DEMO identities active (not production auth).
```

## Stop the demo

Ctrl-C (SIGINT) or `kill` (SIGTERM) — the process closes Fastify and destroys
the DynamoDB client, then exits 0.

## Demo identities (local only)

| Bearer token          | Cognito groups          | Workflow role(s)        |
|-----------------------|-------------------------|-------------------------|
| `demo-po`             | po                      | PO                      |
| `demo-designer`       | service_designer        | SERVICE_DESIGNER        |
| `demo-clinician`      | clinician               | CLINICIAN               |
| `demo-release`        | release_approver        | RELEASE_APPROVER        |
| `demo-developer`      | developer               | ORCHESTRATOR            |
| `demo-po-clinician`   | po + clinician (sub=demo-po) | PO + CLINICIAN     |

Send as `Authorization: Bearer <token>`.

## Scenarios

- **Create a request** (PO): `POST /api/requests` with `demo-po`.
- **Owner reads intake view**: `GET /api/requests/:id` with `demo-po`.
- **Reviewer queue / context**: `GET /api/reviews/queue?category=CLINICAL` and
  `GET /api/requests/:id/review-context?category=CLINICAL` with `demo-clinician`.
- **Clinical approval**: `POST /api/requests/:id/clinical-decisions` with
  `demo-clinician`.
- **Self-approval is rejected**: the same person who owns the request
  (`demo-po-clinician`, sub `demo-po`) cannot clinically approve it → 403.
- **Restart recovery**: a brand-new server process recovers a pending clinical
  approval from DynamoDB + object storage.

These are exercised automatically in
`test/bootstrap.integration.test.ts`.

## Tests

```sh
cd packages/orchestrator
npm run typecheck                                        # 0 errors
npm test                                                 # unit suite (incl. config/cognito/bootstrap)
R2_DYNAMODB_LOCAL_ENDPOINT=http://localhost:8000 \
  npm run test:dynamodb                                  # DynamoDB integration
R2_DYNAMODB_LOCAL_ENDPOINT=http://localhost:8000 \
  node --experimental-strip-types --test test/bootstrap.integration.test.ts   # demo scenarios
```

## Fixtures vs real integrations

Request creation, clinical approval and the rejected self-approval use the REAL
HTTP routes, services, store, workflow and audit. Screening (R3), logic drafting
(R3) and checker results (R4) in the demo are supplied by the existing
**test fixtures** (`FictionalChecker`, `next()`), clearly labelled in the test.
The orchestrator does not fabricate passing checker evidence, clinical
decisions, compiler results or R6 verification — the fixtures only provide the
inputs those existing gates consume.
