# Operational scripts

| Entry point | What it does |
| --- | --- |
| [deploy.sh](deploy.sh) | Applies Terraform, seeds demo users, and writes the local environment file |
| [teardown.sh](teardown.sh) | Tears down the sandbox with safeguards for stored artifacts |
| [kiro/](kiro/) | Runs ordered AWS provisioning, image builds, smoke tests, runner installation, and cost reporting |
| [dynamodb-local/create-table.sh](dynamodb-local/create-table.sh) | Sets up the table for the local orchestrator demo |
| [build-runner-image.sh](build-runner-image.sh) and [build-verifier.sh](build-verifier.sh) | Prepare the runner and verifier for the AWS build flow |

Start with the [Kiro runbook](kiro/RUNBOOK.md) for the sequence and expected outputs.

## Choose a runbook

- **Provision or tear down AWS.** Start with [infrastructure prerequisites](../infra/README.md#prerequisites), then use the [deploy](../infra/README.md#deploy) or [teardown](../infra/README.md#teardown) steps.
- **Check the build without a hosted request.** The Kiro runbook describes steps 20–29 for the image, compiler fixture, runner, Chromium, and verification. Read each step's prerequisites and expected result before running it.
- **Check AWS delivery and runner installation.** Step 30 checks the live Pipes with test records and requires empty queues and a stopped runner. Step 31 installs the runner, starts polling, and checks CloudWatch logging.
- **Review costs.** Step 32 queries Cost Explorer and CloudWatch. See [cost controls](../infra/README.md#cost-controls) for how to interpret tagged and whole-account totals.

The runbook gives expected `RESULT: PASS` lines and where to find logs when a step fails. The [local orchestrator demo](../packages/orchestrator/DEMO.md) covers local API testing with DynamoDB Local.
