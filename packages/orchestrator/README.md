# DesignBrief Routing Box

Run the local unit tests without installing dependencies:

```sh
cd /Users/vivi/Documents/Codex/2026-11-03/hel/work/packages/orchestrator
npm test
```

Verified with Node.js v24.18.0. The test command uses Node's built-in test
runner and TypeScript type stripping. It executes tests but does not type-check
the source. The team's intended Node.js 22 environment needs separate verification.
No shared TypeScript configuration has been changed.

`routeDesignBrief(input)` returns `requestId`, `route`, and structured `reasons`
with a code, field, and message. An absent/invalid request ID returns `null` and
requires designer review. The function has no external connections or side effects.

The provisional `DesignBrief` type lives in `src/routing.ts`. It requires:

- Non-empty `requestId`, `title`, `objective`, and `targetPopulation` strings.
- At least one requirement containing a non-empty `condition` and `action`.
- A top-level `screeningStatus` of exactly `NOT_ASSESSED` or `ASSESSED`.
  Missing, invalid, or `NOT_ASSESSED` status requires designer review, even
  when every review flag array is empty. Values are not normalized or inferred.
- Explicit arrays for `reviewFlags.ambiguities`, `contradictions`, and
  `clinicalSafetyConcerns`. Use `[]` when screening reports no findings;
  omitted or malformed arrays require designer review.

Reported concerns, missing information, or the same condition requesting different
actions produce `NEEDS_SD_REVIEW`. Condition/action comparisons ignore case,
leading/trailing whitespace, and repeated whitespace. Different actions might be
compatible, but a designer must clarify them before automatic routing.

Only explicit `ASSESSED` status with all other checks passing produces
`READY_FOR_BEDROCK_REVIEW`. Neither route is clinical
approval or permission to build, deploy, or release software.

For example, a fictional training checklist with empty finding arrays remains
`NEEDS_SD_REVIEW` while its status is `NOT_ASSESSED`. Marking it `ASSESSED`
allows AI review only if required information and every other check pass.

The router does not independently verify a client-provided `ASSESSED` value.
A future authenticated server-side screening process must establish the status
for the exact brief being routed; changing that brief must require reassessment.
This provisional field is an explicit completeness signal, not proof of screening
or an authorization boundary. Authentication is not implemented here.

This is a structural pre-screen, not a clinical or natural-language validator.
It cannot discover implicit ambiguity, verify reported screening findings, or
recognize equivalent conditions written differently. Callers must preserve known
uncertainty in the review flags; empty arrays must not stand in for an unfinished
assessment. Only fictional/public workflow data belongs in examples.

Before integration, agree this provisional intake contract (including the top-level
`screeningStatus` field and its two exact values) and screening ownership
with the intake and shared-schema teammates. The LogicModel schema remains owned
by the schema workstream. Storage currently lives under `src/storage`; this change
does not create or move a storage package. Authentication, AI calls, workflow state,
and approval enforcement are separate future components.
