# @cht-nocode/drafter (Role 3)

Turns one public guideline plus a program officer's request into a **cited LogicModel v1 draft** using Amazon Bedrock, or returns **explicit blockers**. It never writes CHT configuration (that is Role 5), and nothing it produces is approved: a clinician reviews every draft.

## Follow a draft through the package

1. [extract.ts](src/extract.ts) reads the source Markdown and indexes the guideline by page. The envelope records the source and extracted-text digests.
2. [draft.ts](src/draft.ts) screens the input and sends the request and guideline evidence to the configured model adapter. If validation fails, it can make one retry with the errors.
3. [sources.ts](src/sources.ts) checks quoted text and clinical numbers against the cited pages. Inspect `citations`, `numbers`, and `openBlockingAmbiguities` in the envelope to see which rules need review.
4. The caller receives the candidate logic and its envelope. Check the envelope's `status` and `blockers` before sending the candidate to the [checker](../checker/README.md). Keep the envelope with the candidate so a reviewer can trace the source, model, prompt, and attempts.

[bedrock.ts](src/bedrock.ts) exposes both the practice client for fixture runs and the live Bedrock client. Intake's screening answers whether a product owner's request is complete enough to preview. This package drafts clinical rules from guideline evidence.

## What it guarantees (and the tests that prove it)

| Guarantee | How | Test |
|---|---|---|
| No threshold is silently invented | Every number in a clinical rule must appear on the page it cites (or be a years→months conversion). If not, a **blocking** "Missing threshold" ambiguity is added | 1, 1b |
| Bad model output never gets through | Format checked by the Role 5 compiler (basic check if the compiler is not on the branch). One retry with the errors, then a `schema_failure` blocker | 2a, 2b, 2c |
| Every citation is real | Each quote must appear word for word on the cited page; otherwise a **blocking** "Unsupported claim" ambiguity | 3, 3b |
| Every question and rule is sourced | Missing `source.page`/`source.quote` is sent back to the model once; if still missing, a **blocking** "No citation" ambiguity | 4a, 4b |
| Unusable or personal input stops before the model | Placeholder/empty pages, emails, phone numbers, names; Bedrock Guardrails too in live mode | 5a, 5b |
| Traceable | Source PDF hash, guideline text hash, extractor version, prompt version + hash, model ID, request hash, output hash | 7 |
| Compiler-compatible | `node packages/compiler/src/cli.ts draft.json --out /tmp/x` exits 1 while a blocking ambiguity is open and 0 once a clinician resolves them | format proof (x2) |

Format errors are the compiler's `{ code, path, message }` list, fed back into the prompt once.

## Outputs

- `logic.json`: bare LogicModel v1 (for R4 checks; R5 compiles only the **approved** version via R2).
- `envelope.json`: for R2. Status, provenance, the five screening checks (completeness, ambiguities, contradictions, clinicalSafety, feasibility), citation and number reports, blockers, and a token/cost record for **every** Bedrock attempt.

Exit codes: 0 draft proposed, 1 blocked, 2 usage or file error.

## Run it without AWS (practice mode)

Needs Node.js 22.18 or newer. No `npm install` needed.

```sh
cd packages/drafter
npm test                 # 14 acceptance tests
npm run practice         # replays a saved model answer, writes /tmp/drafter-practice
```

## Run it live in AWS CloudShell

1. AWS console, region **us-west-2**, open **CloudShell** (the `>_` icon).
2. Check Node: `node --version`. If it is older than v22.18, run:
   ```sh
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   source ~/.bashrc && nvm install 22
   ```
3. Get the code and run:
   ```sh
   git clone https://github.com/skootzs/MedicalMobile---AWS-Hackathon.git
   cd MedicalMobile---AWS-Hackathon && git checkout r3-spec
   cd packages/drafter && npm install && npm test
   export BEDROCK_MODEL_ID="<model ID from the Bedrock console>"
   export GUARDRAIL_ID="<ID of cht-nocode-pii-guardrail>" GUARDRAIL_VERSION="DRAFT"
   npm run live
   ```
4. Results are in `/tmp/drafter-live`. Tokens are always recorded; for a dollar figure also set `PRICE_INPUT_PER_MTOK` and `PRICE_OUTPUT_PER_MTOK` from the Bedrock pricing page.

| Setting | Default | Meaning |
|---|---|---|
| `BEDROCK_MODEL_ID` | (required) | Model or inference profile ID |
| `AWS_REGION` | `us-west-2` | Bedrock region |
| `BEDROCK_TIMEOUT_MS` | `120000` | Per-call timeout; throttling/timeouts retried twice |
| `GUARDRAIL_ID`, `GUARDRAIL_VERSION` | unset | Bedrock Guardrails screening of the request. Use the guardrail's **ID or ARN** (not its name, `cht-nocode-pii-guardrail`); version is a number or `DRAFT` |

## Files

`src/extract.ts` guideline pages · `src/screen.ts` input screening · `src/bedrock.ts` the only model adapter · `src/validate.ts` format check · `src/sources.ts` citation and number checks · `src/draft.ts` the pipeline · `src/prompts/draft.md` the prompt · `src/cli.ts` command line.

Not built yet: PreviewProposal from the officer request and corrections (`propose-edit.ts`), the optional independent second extraction (`cross-check.ts`), routing hints (`route-hint.ts`).

## Open items for other roles

- **R4:** replace the compiler-based format check with `packages/schema` when published.
- **R5:** the fixture's fast-breathing quote contains a `;` that is not in the WHO text; the citation check flags it.
- **R7:** IAM for the drafter: Bedrock invoke on the chosen model, ApplyGuardrail, read-only S3 on the guideline prefix, CloudWatch Logs write.
