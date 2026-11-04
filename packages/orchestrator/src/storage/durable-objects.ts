import { referenceMatches } from '../compilation-contracts.ts';
import type { LogicModelReferenceProvider } from '../compilation-contracts.ts';
import { createHash } from 'node:crypto';
import { canonicalizeJson } from '../snapshots.ts';
import type { Snapshot } from '../snapshots.ts';
import { StorageError } from './requests.ts';
export interface ImmutableObjectReference { uri: string; versionId: string; sha256: string; size: number }
/** S3-first port: private/versioned immutable objects; existing bytes must match on conflict.
 * No default implementation, public URI input or browser-provided trusted flags. */
export interface DurableObjects {
  putIfAbsent(key: string, bytes: Uint8Array): Promise<ImmutableObjectReference>;
  read(ref: ImmutableObjectReference): Promise<Uint8Array>;
}
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function readVerified(objects: DurableObjects, ref: ImmutableObjectReference): Promise<Buffer> {
  if (!ref || typeof ref.uri !== 'string' || !ref.uri || typeof ref.versionId !== 'string' || !ref.versionId || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.size) || ref.size < 1) throw new StorageError('INVALID_OBJECT_REFERENCE');
  const bytes = Buffer.from(await objects.read(ref));
  if (bytes.length !== ref.size || sha256(bytes) !== ref.sha256) throw new StorageError('OBJECT_INTEGRITY');
  return bytes;
}
export async function writeVerified(objects: DurableObjects, key: string, bytes: Uint8Array): Promise<ImmutableObjectReference> {
  const ref = await objects.putIfAbsent(key, bytes);
  if (ref.sha256 !== sha256(bytes) || ref.size !== bytes.length) throw new StorageError('OBJECT_WRITE_INTEGRITY');
  await readVerified(objects, ref);
  return ref;
}
/** Same canonical S3 bytes as logicObjectBytes(), also supporting request previews. */
export function snapshotObjectBytes(snapshot: Snapshot): Buffer {
  const { snapshotHash, ...envelope } = snapshot;
  const bytes = Buffer.from(canonicalizeJson(envelope));
  if (sha256(bytes) !== snapshotHash) throw new StorageError('SNAPSHOT_INTEGRITY');
  return bytes;
}

/** Bridge the existing approved-compilation S3-first port; no URI/hash fabrication. */
export class DurableLogicModelReferences implements LogicModelReferenceProvider {
  #objects: DurableObjects;
  constructor(objects: DurableObjects) { this.#objects=objects; }
  async getVerifiedReference(snapshot: import('../snapshots.ts').LogicModelSnapshot) {
    const ref=await writeVerified(this.#objects,`snapshots/${snapshot.snapshotHash}.json`,snapshotObjectBytes(snapshot));
    const result={requestPreview:{...snapshot.requestPreview},logic:{logicRevision:snapshot.revision,logicHash:snapshot.snapshotHash},uri:ref.uri,
      versionId:ref.versionId,verificationId:`object-${ref.sha256}`,representation:'r2-snapshot-envelope-without-hash-v1' as const,
      hashPolicyVersion:snapshot.hashPolicyVersion,byteSha256:ref.sha256,byteLength:ref.size};
    if(!referenceMatches(result,snapshot))throw new StorageError('VERIFIED_SNAPSHOT_REFERENCE_REQUIRED');
    return result;
  }
}
