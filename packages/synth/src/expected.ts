/**
 * Golden cases: load them from a JSON file and expose them. Nothing else.
 *
 * This module computes no outcomes. It does not interpret any field except
 * `id`; every other field is passed through untouched.
 *
 * TODO(golden-case schema): packages/schema/src/golden-cases.schema.json is
 * an empty placeholder. Until it is defined, the accepted file format is
 * provisional: a JSON array of objects, each with a unique non-empty string
 * `id`. Reconcile with the schema package once it exists.
 */
import { readFileSync } from 'node:fs';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface GoldenCase {
  id: string;
  [field: string]: JsonValue;
}

export interface GoldenCaseSet {
  /** In file order. Frozen. */
  readonly cases: readonly Readonly<GoldenCase>[];
  get(id: string): Readonly<GoldenCase> | undefined;
}

export function parseGoldenCases(raw: unknown, file = 'golden cases'): GoldenCaseSet {
  if (!Array.isArray(raw)) throw new Error(`${file}: must be a JSON array of golden cases`);

  const byId = new Map<string, Readonly<GoldenCase>>();
  const cases = raw.map((item: unknown, i): Readonly<GoldenCase> => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`${file}: [${i}] must be an object`);
    }
    const id = (item as Record<string, unknown>)['id'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`${file}: [${i}].id must be a non-empty string`);
    }
    if (byId.has(id)) throw new Error(`${file}: [${i}].id duplicates "${id}"`);
    const frozen = Object.freeze({ ...(item as GoldenCase) });
    byId.set(id, frozen);
    return frozen;
  });

  return Object.freeze({
    cases: Object.freeze(cases),
    get: (id: string) => byId.get(id),
  });
}

export function loadGoldenCases(path: string): GoldenCaseSet {
  return parseGoldenCases(JSON.parse(readFileSync(path, 'utf8')), path);
}
