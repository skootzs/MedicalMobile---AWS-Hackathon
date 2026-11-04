import { canonicalizeJson, createSnapshot, HASH_POLICY_VERSION } from '../snapshots.ts';
import type { Snapshot, SnapshotDraft, SnapshotValidator } from '../snapshots.ts';
import type { SnapshotKey } from './requests.ts';
import { StorageError } from './requests.ts';

export function snapshotKey(snapshot: Snapshot): SnapshotKey {
  const base = { requestId: snapshot.requestId, kind: snapshot.kind, revision: snapshot.revision };
  return snapshot.kind === 'LOGIC_MODEL'
    ? { ...base, kind: 'LOGIC_MODEL', requestPreview: { ...snapshot.requestPreview } }
    : { ...base, kind: 'REQUEST_PREVIEW' };
}
/** Logic revision counters restart after a new preview; scope their immutable slots. */
export function snapshotSlot(key: SnapshotKey): string {
  if (!key || typeof key.requestId !== 'string' || !key.requestId.trim() || !Number.isSafeInteger(key.revision) || key.revision < 1) throw new StorageError('INVALID_SNAPSHOT_KEY');
  if (key.kind === 'REQUEST_PREVIEW') return JSON.stringify([key.requestId, key.kind, key.revision]);
  if (key.kind !== 'LOGIC_MODEL' || !key.requestPreview || key.requestPreview.requestId !== key.requestId ||
      !Number.isSafeInteger(key.requestPreview.revision) || key.requestPreview.revision < 1 || !/^[a-f0-9]{64}$/.test(key.requestPreview.snapshotHash)) throw new StorageError('INVALID_SNAPSHOT_KEY');
  return JSON.stringify([key.requestId, key.kind, key.revision, key.requestPreview.revision, key.requestPreview.snapshotHash]);
}
/** Rebuild with the injected validator, policy and canonicalizer on every load. */
export function verifySnapshot(raw: unknown, validate: SnapshotValidator): Snapshot {
  try {
    const value = JSON.parse(canonicalizeJson(raw)) as Record<string, unknown>;
    if (!value || Array.isArray(value) || typeof value !== 'object' || value.hashPolicyVersion !== HASH_POLICY_VERSION ||
        typeof value.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshotHash)) throw new Error('Invalid snapshot metadata.');
    const allowed = ['kind', 'requestId', 'revision', 'schemaVersion', 'hashPolicyVersion', 'snapshotHash', 'content', ...(value.kind === 'LOGIC_MODEL' ? ['requestPreview'] : [])];
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown stored metadata.');
    const { snapshotHash, hashPolicyVersion, ...draft } = value;
    const rebuilt = createSnapshot(draft as unknown as SnapshotDraft, validate);
    if (rebuilt.snapshotHash !== snapshotHash) throw new Error('Hash mismatch.');
    return rebuilt;
  } catch { throw new StorageError('SNAPSHOT_INTEGRITY', 'Snapshot schema, policy, or hash verification failed.'); }
}
