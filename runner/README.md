# Build runner

The runner executes compile and verification jobs on the AWS app host as the `cht-build-runner` systemd service. [main.ts](src/main.ts) polls SQS. [worker.ts](src/worker.ts) validates the job payload, acquires and renews a DynamoDB lease, checks approval and input hashes, and launches the appropriate Docker stage.

Compile jobs use the [compiler](../packages/compiler/README.md) and convert the generated project with the [build image](../build-image/README.md). Verify jobs run the [verification suite](../packages/verification/README.md) against the compiled project. [store.ts](src/store.ts) manages attempts and audit records. Artifacts go to S3 and the terminal result goes to DynamoDB. An EventBridge Pipe emits the completion notification that the orchestrator can reconcile.

Run `npm test -w runner` from the repository root. For service configuration and Docker smoke tests, use the [integration handoff](../docs/integration-handoff.md#what-the-runner-expects), [job delivery contract](../docs/job-delivery.md), and [Kiro runbook](../scripts/kiro/RUNBOOK.md).

## Job lifecycle

1. The orchestrator writes `JOB#<jobId>/META` and an outbox entry. EventBridge Pipes delivers the outbox payload to SQS.
2. The runner validates the payload and conditionally leases the pending job. It renews the DynamoDB lease and SQS visibility while running a stage. A worker that loses its lease cannot commit a result.
3. For approved mode it checks the approval and logic hash. It fetches the versioned input objects and verifies their digests before launching the build or verification stage.
4. The runner uploads artifacts and records the terminal result for that attempt. Completion events carry a job reference. The orchestrator reads the authoritative result and reconciles it.

## Troubleshoot an attempt

Start with the job's META record and its attempt audit entries, then inspect `systemctl status cht-build-runner` and `/var/log/cht-nocode/runner.log` on the app host. A job can be delivered more than once. An active lease defers redelivery and a terminal job can be acknowledged without rerunning it. The [failure table](../docs/job-delivery.md#lease-retry-and-failure-behavior) distinguishes retryable stage and timeout errors from invalid payloads, hash mismatches, and model rejection.

## Recorded child-cough smoke test

On the Kiro workspace at 4:56 PM Pacific on 4 Nov 2026, commit `cdb0b7d`:

- `scripts/kiro/20-build-image.sh` built the image and launched Chromium.
- `scripts/kiro/25-fixture-end-to-end.sh` compiled the fixture, and cht-conf plus the form harness passed at compiler `7f488e6`.
- `scripts/kiro/29-verify-stage-e2e.sh` ran compile and then verify at verifier `e9f70f6`. With the golden cases, `verificationPassed` was true. Without them, the job still finished and `verificationPassed` was false, because those extra patients have no expected answer.

A clinician has not approved the golden cases. A Medic representative has not confirmed the demo.

| Well-Architected target | Evidence |
|---|---|
| Operational excellence | [Deploy](../infra/README.md#deploy) and [Teardown](../infra/README.md#teardown). One change is the request, the approval record, and the compile hashes |
| Security | Cognito sign-in in [Sign-in](../infra/README.md#sign-in). Synthetic demo users only. Content approval and release approval are separate records, and the compile and verify runners are different actors |
| Reliability | A job starts as `PENDING` and can be ingested again. The checker blocks a release on a blocking finding. Teardown removes the stack |
| Performance efficiency | The Kiro run above. Models are used for drafting and screening. The compiler does not call a model |
| Cost optimization | [Recorded account spend](../infra/README.md#cost-controls), the nightly stop, and [Teardown](../infra/README.md#teardown). A per-run dollar figure needs the `cht-nocode` table |
| Sustainability | Hosts stop at 23:00 America/Los_Angeles and do not restart themselves. The shipped output is ordinary offline CHT configuration |
