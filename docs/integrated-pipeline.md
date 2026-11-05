# Integrated request and release app

The integrated app serves intake, request tracking, reviewer inboxes and approved downloads from one origin. Keep the standalone intake server and its existing Cognito pool for accounts or revisions that have not been migrated.

## Configure the sandbox

1. Apply the reviewed Terraform changes for the app-host intake policy, intake queue index and shared Cognito logout URL. Use the shared pool and client, with the sandbox callback `http://localhost:8080`. Provision separate synthetic users in the `po`, `clinician` and `release_approver` groups. For each product owner, add the `PO` assignment to `roles#<shared-pool sub>` / `assignment` in the intake table.
2. Use the Terraform `integrated_app_environment` output for `MODE=aws`, `AWS_REGION`, `DDB_TABLE`, `ARTIFACT_BUCKET`, `JOB_EVENTS_QUEUE_URL`, `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID`. It also supplies the shared `COGNITO_HOSTED_URL` and `COGNITO_REDIRECT_URI=http://localhost:8080`, and the intake table and bucket names. Do not copy the standalone pool and client values into the integrated environment.
3. Enable screening with `INTAKE_SCREENING_ENABLED=true`, `BEDROCK_MODEL_ID`, `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_VERSION` from the published intake screening environment. Use a permitted model and a numbered guardrail version. Both screening and drafting use this configuration.
4. Prepare a registry JSON mapping baseline names to lowercase SHA-256 hashes. Prepare a separate catalog JSON containing the curated entries below. Upload curator-reviewed guideline Markdown and independently authored golden cases under `sources/` in the versioned artifact bucket. The runtime checks the exact object versions and digests. Repository golden cases are synthetic fixtures for testing.
5. Build and publish the app image from the repository root. Use the existing orchestrator ECR repository and an immutable tag. Redeploy the build runner from the same release so verification reports include the clinical approval and compilation job IDs.

```sh
docker build --platform linux/amd64 -f packages/orchestrator/Dockerfile -t "$APP_IMAGE" .
docker push "$APP_IMAGE"
```

Catalog format. The placeholders represent existing registry hashes, private object versions and byte hashes.

```json
[
  {
    "pathway": "Child cough",
    "baselineVersion": "demo",
    "baselineHash": "<lowercase SHA-256>",
    "guideline": {
      "uri": "s3://<artifact-bucket>/sources/guideline.md",
      "versionId": "<S3 version>",
      "sha256": "<lowercase SHA-256>"
    },
    "goldenCases": {
      "uri": "s3://<artifact-bucket>/sources/golden-cases.json",
      "versionId": "<S3 version>",
      "sha256": "<lowercase SHA-256>"
    }
  }
]
```

## Start and check the app

On the app host, place the registry and catalog in a directory readable by the image’s `node` user. Set `INTAKE_REGISTRY=/config/registry.json` and `PIPELINE_EVIDENCE_CATALOG=/config/catalog.json` in the integrated app environment file. Use the app-host role for AWS access.

```sh
docker run --init --detach --restart unless-stopped --name cht-nocode-app \
  --env-file /etc/cht-nocode/integrated-app.env \
  --mount type=bind,src=/etc/cht-nocode/integrated-config,dst=/config,readonly \
  --publish 127.0.0.1:8080:8080 "$APP_IMAGE"
```

Forward port 8080 through SSM. As the synthetic product owner, submit a request matching the catalog and confirm the automatically generated preview. In separate sessions, approve it from the clinician and release approver inboxes. Inspect the verification evidence before approving release. As the original product owner, download the package and compare its SHA-256 with the released artifact hash. Confirm that the runner processed one compile and one verify job for the revision and that the package was unavailable before release approval.

The CI test uses a local database and recorded model output. It runs the real runner against the pinned compiler, converter and verifier containers, with an in-memory versioned object store for the test.
