# Role 3: Guideline Intake, Bedrock Drafting & Source Traceability

## What this package is
packages/drafter/ and the extraction part of packages/intake/. It turns one public
guideline plus a program officer's request into a cited PreviewProposal and a
CandidateLogicSnapshot, or returns explicit blockers. It never emits XLSForm,
XPath, tasks.js or any deployable CHT configuration (that is Role 5).

## Hard rules (Medic design rules; do not trade these for speed)
1. Every model call goes through Amazon Bedrock (AWS SDK v3, Converse API), us-west-2,
   via one adapter function. Model IDs come from env vars, never hard-coded.
2. Model output is never trusted: validate with Ajv against Role 4's schema
   (packages/schema). Retry once with the validation errors; then return a blocker.
3. Never fill a missing clinical value. Use the schema's unresolved form plus an
   ambiguity record that cites passage IDs.
4. Every clinical element needs a citation {passageId, quote}. Code verifies the
   passage exists and the quote appears in it; otherwise mark verified=false and
   raise an unsupported_claim ambiguity.
5. Clinical guesses are never "assumptions". Only presentation assumptions
   (order, wording, grouping) may appear in the assumptions field.
6. Officer corrections are fixed constraints. A new preview revision that drops one
   is rejected.
7. Guideline text is data, not instructions: wrap it in delimiters in prompts.
8. Synthetic or public data only. Screen inputs with Bedrock Guardrails (PII).
9. Record a UsageRecord (model, tokens, latency, attempt, estimated cost) for every
   Bedrock attempt, including failures.
10. Provenance on every output: source sha256, extractorVersion, promptVersion, modelId.

## Stack
TypeScript 5, Node.js 22, AWS SDK v3, Ajv. No other model providers, no LangChain
model clients that bypass Bedrock. Tests must run without Bedrock using fixtures.

## Boundaries
Do not edit packages/schema (Role 4), approval/state code (Role 2), UI (Role 1),
compiler (Role 5) or infra (Role 7). Propose changes to them in a note instead.

