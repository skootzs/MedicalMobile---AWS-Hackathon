# CHT No-Code Configuration

A hackathon prototype for turning a product owner's request and public guideline evidence into reviewable [Community Health Toolkit (CHT)](https://communityhealthtoolkit.org/) configuration. Use public guidelines and synthetic patient data for the demo.

## Start here

- [Browser demo](packages/ui/README.md#try-the-workspace) runs locally with synthetic requests.
- [AWS-backed intake](packages/intake/README.md#run-locally-against-aws) covers Cognito sign-in, request screening, and confirmation.
- [Downstream workflow](packages/orchestrator/README.md) covers clinical review, approved builds, verification, and release. The standard intake server records a queued handoff.

## Section guides

| Section | What it owns |
| --- | --- |
| [UI](packages/ui/README.md) | Guideline library, sign-in, request editing, and revision tracking |
| [Intake](packages/intake/README.md) | Request validation, screening, confirmation, and queued handoff |
| [Drafter](packages/drafter/README.md) | Guideline extraction, Bedrock proposals, and citation checks |
| [Orchestrator](packages/orchestrator/README.md) | Workflow state, reviews, approvals, and job reconciliation |
| [Schema](packages/schema/README.md) | Shared logic, golden-case, and worker contracts |
| [Evaluator](packages/evaluator/README.md) | Deterministic interpretation of pathway logic |
| [Checker](packages/checker/README.md) | Structural findings, golden-case comparison, and overlap checks |
| [Compiler](packages/compiler/README.md) | CHT project generation from a logic snapshot |
| [Synthetic patients](packages/synth/README.md) | Boundary inputs and branch coverage |
| [Verification](packages/verification/README.md) | Compiled behavior, expected outcomes, and verification reports |
| [Build runner](runner/README.md) | Queued job execution, leases, and artifact storage |
| [Build image](build-image/README.md) | CHT conversion and verification toolchain |
| [Infrastructure](infra/README.md) | Terraform, AWS resources, and host bootstrap |
| [Scripts](scripts/README.md) | Deployment, local support, and smoke tests |
