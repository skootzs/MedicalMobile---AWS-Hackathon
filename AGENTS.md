# Agent rules

Canonical rules for all AI coding assistants working in this repo.

- A model never writes shipped CHT config; only the deterministic compiler does.
- Golden cases come from the guideline, never from the logic model.
- Every change needs content approval and a separate release approval, bound to a snapshot hash.
- Synthetic data only; no credentials or patient data in the repo.
- `schema`, `evaluator`, `checker`, `compiler`, `synth` must never import `drafter` (no AI in the
  deterministic path). TODO: this repo's package layout doesn't yet match the six-part structure
  referenced elsewhere (`5-evaluation-approval`, `6-compile-release`, `@cht-nocode/bedrock`); when it
  does, retarget this rule accordingly.
- Budget: $400 team total; develop against Haiku/fixtures, not Opus.
- Don't change `packages/schema` without team agreement.
