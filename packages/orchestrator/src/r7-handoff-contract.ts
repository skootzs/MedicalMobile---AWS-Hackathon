/**
 * R7 job-delivery contract boundary (REPLACEABLE).
 *
 * R7 owns the authoritative payload/result schemas at
 *   packages/schema/src/handoffs.ts  (on the `r7-infra` branch, commit 9a61462),
 *   CONTRACT_VERSION "1.1.0".
 * That package is not merged here yet, so this file keeps a small, labelled
 * MIRROR of R7's JobPayload (COMPILE_LOGIC) and VerifyBuildPayload schemas
 * (patterns + required fields copied verbatim from handoffs.ts) plus Ajv
 * validators, so R2 can validate the exact wire payload it EMITS into
 * `JOB#<jobId>/OUTBOX.payload` against R7's shape before persisting it. Replace
 * with a direct import of R7's validateJobPayload / validateVerifyBuildPayload
 * when the branch merges — do not let this diverge into a competing schema. A
 * test validates parity against the actual handoffs.ts at commit 9a61462.
 *
 * Contract-version note: R7's ACCEPTED_PAYLOAD_VERSIONS = ['1.0.0','1.1.0'].
 * 1.1.0 only ADDS optional fields (goldenCasesUri/goldenCasesHash), so a sender
 * still emitting 1.0.0 stays valid. R2 continues to emit contractVersion
 * "1.0.0" (it owns no authoritative golden-case object reference to populate the
 * 1.1.0 additions), and these validators accept both.
 */
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';

/** R7's CONTRACT_VERSION (handoffs.ts). R2 may still emit 1.0.0 (accepted below). */
export const R7_CONTRACT_VERSION = '1.1.0' as const;
/** Versions R7 accepts on an inbound payload. R2 emits 1.0.0 deliberately. */
export const R7_ACCEPTED_PAYLOAD_VERSIONS = ['1.0.0', R7_CONTRACT_VERSION] as const;
/** R7's logicModelHash/hash pattern (handoffs.ts LOGIC_MODEL_HASH_PATTERN). */
const HASH_PATTERN = '^[A-Za-z0-9:_-]{8,128}$';
/** Golden cases are set together or not at all (handoffs.ts goldenCasesTogether). */
const goldenCasesTogether = { goldenCasesUri: ['goldenCasesHash'], goldenCasesHash: ['goldenCasesUri'] };

/** Properties shared by every JobPayload (handoffs.ts jobPayloadSchema). */
const jobPayloadProperties = {
  contractVersion: { enum: R7_ACCEPTED_PAYLOAD_VERSIONS as unknown as string[] },
  jobId: { type: 'string', minLength: 1 },
  jobType: { type: 'string', enum: ['DRAFT_LOGIC', 'COMPILE_LOGIC', 'VERIFY_BUILD'] },
  mode: { type: 'string', enum: ['preview', 'approved'], nullable: true },
  requestId: { type: 'string', minLength: 1 },
  revision: { type: 'integer', minimum: 0 },
  logicModelHash: { type: 'string', pattern: HASH_PATTERN },
  snapshotUri: { type: 'string', minLength: 1 },
  checkReportHash: { type: 'string', minLength: 1 },
  clinicalApprovalId: { type: 'string', nullable: true },
  baselineHash: { type: 'string', nullable: true },
  baselineUri: { type: 'string', nullable: true },
  taskWindow: { type: 'string', pattern: '^\\d+,\\d+$', nullable: true },
  goldenCasesUri: { type: 'string', minLength: 1, nullable: true },
  goldenCasesHash: { type: 'string', minLength: 1, nullable: true },
  createdBy: { type: 'string', minLength: 1 },
  createdAt: { type: 'string', minLength: 1 },
} as const;
const jobPayloadRequired = [
  'contractVersion', 'jobId', 'jobType', 'requestId', 'revision', 'logicModelHash', 'snapshotUri',
  'checkReportHash', 'clinicalApprovalId', 'createdBy', 'createdAt',
] as const;

/** Mirror of R7 jobPayloadSchema specialized to COMPILE_LOGIC. Replace on merge. */
export const compilationPayloadSchema = {
  type: 'object',
  additionalProperties: false,
  dependencies: goldenCasesTogether,
  properties: { ...jobPayloadProperties, jobType: { const: 'COMPILE_LOGIC' } },
  required: [...jobPayloadRequired],
  // mode = 'approved' requires a non-null clinicalApprovalId.
  if: { properties: { mode: { const: 'approved' } }, required: ['mode'] },
  then: { properties: { clinicalApprovalId: { type: 'string', minLength: 1 } } },
} as const;

/** Mirror of R7 verifyBuildPayloadSchema (handoffs.ts). Replace on merge. */
export const verifyBuildPayloadSchema = {
  type: 'object',
  additionalProperties: false,
  dependencies: goldenCasesTogether,
  properties: {
    ...jobPayloadProperties,
    jobType: { const: 'VERIFY_BUILD' },
    compileJobId: { type: 'string', minLength: 1 },
    packageUri: { type: 'string', minLength: 1 },
    packageHash: { type: 'string', minLength: 1 },
    compileArtifactHash: { type: 'string', minLength: 1 },
    manifestHash: { type: 'string', minLength: 1 },
  },
  required: [
    ...jobPayloadRequired,
    'compileJobId', 'packageUri', 'packageHash', 'compileArtifactHash', 'manifestHash',
  ],
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const compiledCompile: ValidateFunction = ajv.compile(compilationPayloadSchema);
const compiledVerify: ValidateFunction = ajv.compile(verifyBuildPayloadSchema);

export interface PayloadValidation { ok: boolean; errors: string[] }
const toValidation = (fn: ValidateFunction, payload: unknown): PayloadValidation =>
  fn(payload) ? { ok: true, errors: [] } : { ok: false, errors: (fn.errors ?? []).map(e => `${e.instancePath} ${e.message}`.trim()) };

/** Validate an outgoing COMPILE_LOGIC payload against R7's published shape. */
export function validateCompilationPayload(payload: unknown): PayloadValidation {
  return toValidation(compiledCompile, payload);
}
/** Validate an outgoing VERIFY_BUILD payload against R7's published shape. */
export function validateVerifyBuildPayload(payload: unknown): PayloadValidation {
  return toValidation(compiledVerify, payload);
}
