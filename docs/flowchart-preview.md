# Flowchart preview

After a successful screening, the browser requests a preview once. The server sends the normalized requirements and screening summary to the configured Bedrock model, adds its Mermaid output to the version-bound preview and stores it. A saved preview is reused. The graph is an unvalidated draft; it does not read attached guideline text and does not replace source-traced clinical drafting, clinical approval, synthetic testing or release approval.

## Local demo

Run `npm install` from the repository root, then `node packages/ui/test/test-server.js`. Open http://127.0.0.1:3197. This test server returns a fixed sample flowchart and uses an in-memory test screener, not Bedrock. Data disappears when the process stops. Old saved previews without a diagram remain unchanged.

## AWS configuration

Configure the existing production intake settings described in the root README, including `INTAKE_SCREENING_ENABLED`, `BEDROCK_MODEL_ID`, `BEDROCK_GUARDRAIL_ID`, `BEDROCK_GUARDRAIL_VERSION`, region and Cognito/storage settings. Add `FLOWCHART_MODEL_ID` to the service environment; `us.anthropic.claude-sonnet-4-6` is the requested candidate, subject to availability, model access, permissions and acceptable US cross-region routing. Never put AWS keys in browser code or the repository. The service role needs permission to invoke the selected profile and its routed models. `BEDROCK_TIMEOUT_MS` also controls the diagram timeout. Restart the service after changes.

## Validation

Run `node --test packages/intake/review.test.js packages/ui/test/controller.test.js packages/ui/test/requests.test.js`. In a configured sandbox verify a successful real screening and preview, then refresh and confirm the same diagram is loaded without another generation. Check model failure and malformed Mermaid separately. Parallel preview requests can incur duplicate model calls; only a conditional-write winner is saved. The UI allows inline CSS in its content security policy for Mermaid SVG styling, while scripts remain same-origin only.
