/**
 * R7 job-delivery contract.
 *
 * The authoritative VerifyBuildPayload schema is packages/schema/src/handoffs.ts
 * on this branch. This module validates outgoing payloads against that schema.
 */
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { CONTRACT_VERSION, jobPayloadSchema, verifyBuildPayloadSchema } from '../../schema/src/handoffs.ts';

export const R7_CONTRACT_VERSION = CONTRACT_VERSION;
export { verifyBuildPayloadSchema };

const ajv = new Ajv({ allErrors: true, strict: false });
const compiledJob: ValidateFunction = ajv.compile(jobPayloadSchema);
const compiled: ValidateFunction = ajv.compile(verifyBuildPayloadSchema);

export interface PayloadValidation { ok: boolean; errors: string[] }

function payloadResult(check: ValidateFunction, payload: unknown): PayloadValidation {
  if (check(payload)) return { ok: true, errors: [] };
  return { ok: false, errors: (check.errors ?? []).map(e => `${e.instancePath} ${e.message}`.trim()) };
}

/** Validate an outgoing COMPILE_LOGIC payload against R7's published shape. */
export function validateCompilationPayload(payload: unknown): PayloadValidation {
  return payloadResult(compiledJob, payload);
}

/** Validate an outgoing VERIFY_BUILD payload against R7's published shape. */
export function validateVerifyBuildPayload(payload: unknown): PayloadValidation {
  return payloadResult(compiled, payload);
}
