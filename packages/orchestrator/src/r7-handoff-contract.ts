/**
 * R7 job-delivery contract boundary (REPLACEABLE).
 *
 * R7 owns the authoritative payload/result schemas at
 *   packages/schema/src/handoffs.ts  (on the `r7-infra` branch, commit 6f7e8b1),
 *   CONTRACT_VERSION "1.0.0".
 * That package is not merged here yet, so this file keeps a small, labelled
 * MIRROR of R7's VerifyBuildPayload schema (pattern + required fields copied
 * from handoffs.ts) plus an Ajv validator, so R2 can validate the payload it
 * EMITS against R7's shape before persisting it to the outbox. Replace with a
 * direct import of R7's validateVerifyBuildPayload when the branch merges — do
 * not let this diverge into a competing schema.
 */
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';

export const R7_CONTRACT_VERSION = '1.0.0' as const;
/** R7's logicModelHash/hash pattern (handoffs.ts LOGIC_MODEL_HASH_PATTERN). */
const HASH_PATTERN = '^[A-Za-z0-9:_-]{8,128}$';

/** Mirror of R7 verifyBuildPayloadSchema (handoffs.ts). Replace on merge. */
export const verifyBuildPayloadSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contractVersion: { const: R7_CONTRACT_VERSION },
    jobId: { type: 'string', minLength: 1 },
    jobType: { const: 'VERIFY_BUILD' },
    mode: { type: 'string', enum: ['preview', 'approved'], nullable: true },
    requestId: { type: 'string', minLength: 1 },
    revision: { type: 'integer', minimum: 0 },
    logicModelHash: { type: 'string', pattern: HASH_PATTERN },
    snapshotUri: { type: 'string', minLength: 1 },
    checkReportHash: { type: 'string', minLength: 1 },
    clinicalApprovalId: { type: 'string', nullable: true },
    baselineHash: { type: 'string', nullable: true },
    baselineUri: { type: 'string', nullable: true },
    taskWindow: { type: 'string', nullable: true },
    createdBy: { type: 'string', minLength: 1 },
    createdAt: { type: 'string', minLength: 1 },
    compileJobId: { type: 'string', minLength: 1 },
    packageUri: { type: 'string', minLength: 1 },
    packageHash: { type: 'string', minLength: 1 },
    compileArtifactHash: { type: 'string', minLength: 1 },
    manifestHash: { type: 'string', minLength: 1 },
  },
  required: [
    'contractVersion', 'jobId', 'jobType', 'requestId', 'revision', 'logicModelHash', 'snapshotUri',
    'checkReportHash', 'clinicalApprovalId', 'createdBy', 'createdAt',
    'compileJobId', 'packageUri', 'packageHash', 'compileArtifactHash', 'manifestHash',
  ],
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled: ValidateFunction = ajv.compile(verifyBuildPayloadSchema);

export interface PayloadValidation { ok: boolean; errors: string[] }

/** Validate an outgoing VERIFY_BUILD payload against R7's published shape. */
export function validateVerifyBuildPayload(payload: unknown): PayloadValidation {
  if (compiled(payload)) return { ok: true, errors: [] };
  return { ok: false, errors: (compiled.errors ?? []).map(e => `${e.instancePath} ${e.message}`.trim()) };
}
