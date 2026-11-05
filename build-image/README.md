# CHT build image

The [Dockerfile](Dockerfile) packages the CHT conversion and verification tools for the [build runner](../runner/README.md). The stage image keeps the CHT harness and Chromium dependencies together.

- [run-convert.sh](run-convert.sh) runs CHT conversion against the generated project.
- [run-verify.sh](run-verify.sh) launches the verifier against the compiled project and supplied cases.
- [run-build.ts](run-build.ts) drives the build image's build and preview tooling.

Use the [Kiro runbook](../scripts/kiro/RUNBOOK.md) to build the x86_64 image and run the Chromium, conversion, and verification smoke checks.

## Stage inputs and outputs

| Stage | Reads | Writes |
| --- | --- | --- |
| Convert | Generated CHT project in `/work` | Compiled app settings, converted form XML, and `convert.log` in `/work` |
| Verify | Converted project in `/project`, verifier in `/verifier`, and runner inputs under `/in` | `report.json` and `verification.log` in `/out` |

Convert runs `compile-app-settings`, `convert-app-forms`, and `validate-app-forms` at project scope. Verify reuses the converted artifact, supplies its hashes to the verifier, and loads the image's Chromium-backed harness. Verify exits 0 on success, 1 for a verification failure with a report, and 2 for a runner error or missing report.

Use [step 20](../scripts/kiro/20-build-image.sh) for the image and Chromium smoke test, [step 25](../scripts/kiro/25-fixture-end-to-end.sh) for a fixture compile and convert, and [step 29](../scripts/kiro/29-verify-stage-e2e.sh) for a complete runner compile and verify check. If verification fails, read the case results in `report.json` and the process output in `verification.log`.
