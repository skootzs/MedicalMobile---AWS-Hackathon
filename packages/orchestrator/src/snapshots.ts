import { createHash } from 'node:crypto';
import { types } from 'node:util';
import canonicalize from 'canonicalize';
import type { RevisionIdentity } from './routing.ts';
import type { LogicIdentity } from './workflow.ts';

/** Provisional R2 policy: changing hash coverage requires a new policy identifier. */
export const HASH_POLICY_VERSION = 'jcs-sha256-v1' as const;
export type JsonValue = null | boolean | number | string | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue }
export type SnapshotKind = 'REQUEST_PREVIEW' | 'LOGIC_MODEL';
export interface SnapshotValidationContext {
  readonly kind: SnapshotKind;
  readonly schemaVersion: string;
}
/** Throw on rejection. Must be synchronous and must not transform the frozen input. */
export type SnapshotValidator = (content: JsonObject, context: SnapshotValidationContext) => void;
interface SnapshotBase {
  readonly requestId: string;
  /** Preview and LogicModel revisions are separate counters, both starting at 1. */
  readonly revision: number;
  readonly schemaVersion: string;
  readonly hashPolicyVersion: typeof HASH_POLICY_VERSION;
  readonly snapshotHash: string;
  readonly content: JsonObject;
}
export interface RequestPreviewSnapshot extends SnapshotBase {
  readonly kind: 'REQUEST_PREVIEW';
}
export interface LogicModelSnapshot extends SnapshotBase {
  readonly kind: 'LOGIC_MODEL';
  readonly requestPreview: Readonly<RevisionIdentity>;
}
export type Snapshot = RequestPreviewSnapshot | LogicModelSnapshot;
type SnapshotErrorCode = 'INVALID_JSON' | 'INVALID_METADATA' | 'SCHEMA_REJECTED';
export interface SnapshotDraft {
  kind: SnapshotKind;
  requestId: string;
  revision: number;
  schemaVersion: string;
  content: unknown;
  /** Required only for LogicModel snapshots; same requestId as the snapshot. */
  requestPreview?: RevisionIdentity;
}
export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  constructor(code: SnapshotErrorCode, message: string) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

function fail(message: string): never { throw new SnapshotError('INVALID_JSON', message); }
function validUnicode(value: string): boolean {
  // JCS rejects lone UTF-16 surrogates, including in property names. No NFC folding.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
/** Strict JSON-domain validation and immutable copy, NOT a custom canonicalizer. */
function copyJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (!validUnicode(value)) fail('Lone Unicode surrogate is not supported.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Only finite IEEE-754 numbers are supported.');
    return value;
  }
  if (typeof value !== 'object') fail('Only JSON values are supported; undefined, functions, symbols, and bigint are rejected.');
  if (types.isProxy(value)) fail('Proxy objects are not supported.');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    fail('Only plain JSON objects and arrays are supported; no toJSON conversion is performed.');
  }
  if (ancestors.has(value)) fail('Circular references are not supported.');
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) fail('Symbol properties are not supported.');
    for (const key of keys as string[]) {
      if (array && key === 'length') continue;
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !('value' in descriptor)) fail('Hidden properties and accessors are not supported.');
      if (!validUnicode(key)) fail('Lone Unicode surrogate in property name.');
    }
    if (array) {
      if (keys.length !== value.length + 1) fail('Sparse arrays and extra array properties are not supported.');
      const result: JsonValue[] = [];
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(descriptors, String(i))) fail('Sparse arrays are not supported.');
        result.push(copyJson(descriptors[String(i)].value, ancestors));
      }
      return Object.freeze(result);
    }
    const result: Record<string, JsonValue> = Object.create(null);
    for (const key of keys as string[]) result[key] = copyJson(descriptors[key].value, ancestors);
    return Object.freeze(result);
  } finally { ancestors.delete(value); }
}
function object(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function serialize(value: JsonValue): string {
  const result = canonicalize(value);
  if (result === undefined) fail('Canonicalization produced no JSON.');
  return result;
}
/** Uses canonicalize@3.0.0 for RFC 8785 ordering and ECMAScript serialization. */
export function canonicalizeJson(value: unknown): string { return serialize(copyJson(value)); }
const identifier = (value: JsonValue | undefined): value is string => typeof value === 'string' && value.trim().length > 0 && value === value.trim();
const positive = (value: JsonValue | undefined): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Hashes the entire canonical metadata/content envelope, excluding snapshotHash.
 * A hash is an integrity fingerprint, never clinical approval or release permission.
 * Input is already-parsed JSON data, not raw JSON text (see README parsing limits).
 */
export function createSnapshot(input: SnapshotDraft, validate: SnapshotValidator): Snapshot {
  const draft = copyJson(input);
  const invalid = (message: string): never => { throw new SnapshotError('INVALID_METADATA', message); };
  if (!object(draft)) return invalid('Snapshot draft must be an object.');
  const { kind, requestId, revision, schemaVersion, content } = draft;
  if ((kind !== 'REQUEST_PREVIEW' && kind !== 'LOGIC_MODEL') || !identifier(requestId) || !positive(revision) || !identifier(schemaVersion)) {
    return invalid('Valid kind, requestId, positive safe revision, and schemaVersion are required.');
  }
  const allowed = ['kind', 'requestId', 'revision', 'schemaVersion', 'content', ...(kind === 'LOGIC_MODEL' ? ['requestPreview'] : [])];
  if (Object.keys(draft).some(key => !allowed.includes(key))) return invalid('Unknown metadata fields are rejected; callers must not supply snapshotHash or hashPolicyVersion.');
  if (content === undefined || !object(content)) return invalid('Snapshot content must be a JSON object.');
  let requestPreview: Readonly<RevisionIdentity> | undefined;
  if (kind === 'LOGIC_MODEL') {
    const ref = draft.requestPreview;
    if (ref === undefined || !object(ref) || Object.keys(ref).length !== 3 || ref.requestId !== requestId ||
        !positive(ref.revision) || typeof ref.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(ref.snapshotHash)) {
      return invalid('LogicModel snapshot must reference the exact request preview identity for the same request.');
    }
    requestPreview = Object.freeze({ requestId, revision: ref.revision, snapshotHash: ref.snapshotHash });
  }
  if (typeof validate !== 'function') throw new SnapshotError('SCHEMA_REJECTED', 'An explicit schema validator is required.');
  try {
    const returned = validate(content, Object.freeze({ kind, schemaVersion }));
    if (returned !== undefined) throw new Error('Validator must be synchronous and return no transformed content.');
  } catch (error) {
    throw new SnapshotError('SCHEMA_REJECTED', error instanceof Error ? error.message : 'Schema validator rejected content.');
  }
  const base = { kind, requestId, revision, schemaVersion, hashPolicyVersion: HASH_POLICY_VERSION, content };
  const envelope = requestPreview ? { ...base, requestPreview } : base;
  const snapshotHash = createHash('sha256').update(canonicalizeJson(envelope), 'utf8').digest('hex');
  return Object.freeze({ ...envelope, snapshotHash }) as Snapshot;
}

/** Shape-only adapter inspired by R5's draft; not full R4/clinical validation. */
export const provisionalSnapshotValidator: SnapshotValidator = (content, context) => {
  if (context.schemaVersion !== '1.0') throw new Error('Provisional adapter supports schemaVersion 1.0 only.');
  const nonempty = (value: JsonValue | undefined) => typeof value === 'string' && value.trim().length > 0;
  if (context.kind === 'REQUEST_PREVIEW') {
    for (const key of ['title', 'objective', 'targetPopulation']) if (!nonempty(content[key])) throw new Error(`Missing preview ${key}.`);
    if (!Array.isArray(content.requirements) || content.requirements.length === 0) throw new Error('Preview requirements are required.');
    for (const requirement of content.requirements) {
      if (!object(requirement) || !nonempty(requirement.condition) || !nonempty(requirement.action)) throw new Error('Preview needs condition/action requirements.');
    }
  } else {
    if (content.schemaVersion !== context.schemaVersion) throw new Error('Content schemaVersion must match snapshot metadata.');
    for (const key of ['pathwayId', 'title']) if (!nonempty(content[key])) throw new Error(`Missing model ${key}.`);
    if (content.language !== 'en') throw new Error('Provisional compiler proposal supports en only.');
    for (const key of ['sources', 'context', 'questions', 'derived', 'decisionTables', 'outcomes', 'ambiguities']) {
      if (!Array.isArray(content[key])) throw new Error(`Missing model array ${key}.`);
    }
    if ((content.decisionTables as readonly JsonValue[]).length !== 1) throw new Error('Provisional proposal requires exactly one decision table.');
  }
  // All JSON fields, including unknown extensions, remain in the hash. R4 will
  // decide allowable fields, references, expression semantics and clinical checks.
};
export function requestPreviewIdentity(snapshot: Snapshot): RevisionIdentity {
  if (snapshot.kind !== 'REQUEST_PREVIEW') throw new Error('A LogicModel snapshot is not a request preview.');
  return Object.freeze({ requestId: snapshot.requestId, revision: snapshot.revision, snapshotHash: snapshot.snapshotHash });
}
export function logicModelIdentity(snapshot: Snapshot): LogicIdentity {
  if (snapshot.kind !== 'LOGIC_MODEL') throw new Error('A request preview is not a LogicModel snapshot.');
  return Object.freeze({ logicRevision: snapshot.revision, logicHash: snapshot.snapshotHash });
}
