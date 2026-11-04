import { readFileSync } from 'node:fs';
import { Ajv, type ErrorObject } from 'ajv';
import logicModelSchema from './logic-model.schema.json' with { type: 'json' };
import goldenCasesSchema from './golden-cases.schema.json' with { type: 'json' };

export interface SchemaError {
  path: string;
  message: string;
}

export type SchemaResult = { ok: true } | { ok: false; errors: SchemaError[] };

const ajv = new Ajv({ allErrors: true, strict: false });
const validateModel = ajv.compile(logicModelSchema);
const validateCases = ajv.compile(goldenCasesSchema);

function errorsOf(errors: ErrorObject[] | null | undefined): SchemaError[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || '$',
    message: error.message ?? 'invalid',
  }));
}

export function validateLogicModel(model: unknown): SchemaResult {
  if (validateModel(model)) return { ok: true };
  return { ok: false, errors: errorsOf(validateModel.errors) };
}

export function validateGoldenCases(cases: unknown): SchemaResult {
  if (validateCases(cases)) return { ok: true };
  return { ok: false, errors: errorsOf(validateCases.errors) };
}

/** Read a JSON file. Callers validate the value with the functions above. */
export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
