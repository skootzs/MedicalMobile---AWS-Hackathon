# DesignBrief eligibility gate and Routing Box

Run fictional unit tests without installing dependencies:

```sh
cd /Users/vivi/Documents/Codex/2026-11-03/hel/work/packages/orchestrator
npm test
```

Verified with Node.js v24.18.0. Node strips TypeScript types to execute these
runtime tests; it does not perform static type checking. The team's Node.js 22
runtime still needs verification. No shared configuration was changed.

## Ownership and input contract

All contracts in `src/routing.ts` are provisional and local to this package.
Initial AI screening and the intake UI belong to other workstreams. This module
only validates their evidence and computes a decision.

`routeDesignBrief(input)` accepts an internal `RoutingInput` envelope containing:

- `currentRevision`: the authoritative current `requestId`, `revision`, and
  `snapshotHash`, loaded independently of the submitted evidence.
- `currentScreeningId`: the authoritative selected screening attempt.
- `brief`: the same identity plus `title`, `objective`, `targetPopulation`, and
  condition/action `requirements`.
- `screening`: the same identity, `screeningId`, status (`PENDING`, `COMPLETED`,
  or `FAILED`), and all five assessment areas: `completeness`, `ambiguities`,
  `contradictions`, `clinicalSafety`, and `feasibility`.
- `confirmation`: the same identity, `confirmationId`, the applicable
  `screeningId`, and a decision (`CONFIRMED` or `REVISION_REQUESTED`).

Each screening area has an `outcome` and explicit `reasons` array:

- `CLEAR` requires an empty reasons array.
- `NEEDS_REVIEW` requires at least one non-empty unresolved concern.
- `NOT_ASSESSED` blocks eligibility, even if screening says `COMPLETED`.

Unknown assessment areas/outcomes or inconsistent outcome/reason combinations
block eligibility. Input is expected to be ordinary JSON data, not executable
objects or proxies. IDs are non-empty strings without outer whitespace. Revision
numbers are positive safe integers. Hashes must be 64 lowercase hexadecimal digits.

## Eligibility before routing

| Result | Meaning |
| --- | --- |
| `NOT_READY` | Missing, malformed, stale, failed, incomplete, unconfirmed, or conflicting evidence. Do not create a Service Designer task. |
| `NEEDS_SD_REVIEW` | Prerequisites are valid and current, but completed screening reports concerns or local structural checks find missing workflow content or contradictory actions. |
| `READY_FOR_BEDROCK_REVIEW` | Prerequisites are valid and current, all five checks are clear, and local structural checks find no concerns. |

Invalid prerequisites take precedence over concerns: a clinical finding plus a
missing PO confirmation is `NOT_READY`, not an automatically created SD task.

Results include the current revision identity, evidence record IDs, structured
reason codes/field locations/messages, and `clinicalApprovalRequired: true`.
Missing/invalid identity fields are returned as `null`; no IDs or hashes are invented.
An evidence ID in a blocked result is diagnostic, not proof the evidence was accepted.

The function creates no queues, jobs, state transitions, model calls, or audit
writes. A returned route never automatically starts downstream review. Future
workflow code must explicitly decide and record the next action.

## Trust and snapshot identity

This is NOT an endpoint accepting browser-provided proof. Future server code must
load current pointers, screening, and PO confirmation from authoritative storage,
authenticate who may write them, and validate model output before recording a
completed screening. Matching hashes alone do not establish authenticity.
A browser `trusted: true` flag is not evidence. This pure module cannot enforce
authentication, verify the actual snapshot bytes, or discover omitted records.

The brief, screening, and PO confirmation must all match the authoritative current
identity exactly. Confirmation must reference the selected screening attempt.
Even mutually consistent old evidence fails if the authoritative current revision
has advanced. Multiple candidate records are not accepted in place of a selected
record; future storage code must resolve the authoritative attempt explicitly.

Production hashing is not implemented. The schema and intake teammates must agree
on canonical snapshot serialization and hash coverage. Tests use fixed fictional
64-character fingerprints. Initial screening must cover the final proposed snapshot
shown to the PO. Any content edit needs a new revision, screening, and confirmation.
Records should remain immutable; finding resolution must not erase old concerns.

## Clinical safety and limitations

Preliminary AI screening and PO confirmation are not clinical approval. Bedrock
Guardrails safety controls are also distinct from substantive screening.
Service Designers may clarify workflow requirements but cannot waive clinical
approval. Any clinical safety concern needs appropriate human clinical review
before final release. Independent clinician approval, developer verification,
and release approval remain mandatory later, including when all AI checks are clear.
The result's constant clinical-approval requirement is a reminder, not an implemented
approval gate; later workflow/authentication/storage code must enforce it and preserve
clinical concern history across revisions.

Local checks retain required workflow fields and same-condition/different-action
conflict detection. Whitespace is normalized for comparisons, but case is preserved
so identifiers such as `fieldA` and `fielda` are not silently equated. The router
cannot understand clinical prose or prove feasibility or semantic consistency.
Reported concerns are preserved with their assessment field and message.

## Integration decisions still needed

Agree the provisional field names, positive revision numbering, hash format and
canonical snapshot coverage; the selected-screening pointer and retry policy;
how PO identities and permissions are recorded; and finding resolution/clinical
escalation ownership. The shared-schema owner controls any eventual shared types.
Storage placeholders remain under `src/storage`; no storage package is created.

The next small component can be a pure `workflow.ts` transition function that maps
routing results into waiting/review states, rejects stale transition attempts, and
returns an explicit proposed action without executing it. It must not interpret
`NOT_READY` as a Service Designer task or a route as an approval or release grant.
