/** TEST ONLY: fictional private-object registry, no S3 or medical content generation. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { logicObjectBytes, LOGIC_OBJECT_FORMAT } from '../../src/compilation-contracts.ts';
import type { LogicModelReferenceProvider, VerifiedLogicModelReference } from '../../src/compilation-contracts.ts';
import type { LogicModelSnapshot } from '../../src/snapshots.ts';
import { CompilationHandoffService } from '../../src/compilations.ts';
import type { CompilationCommand, CompilationHandoffDependencies } from '../../src/compilations.ts';
import type { CompilationStore } from '../../src/storage/compilations.ts';
import { ApprovalService } from '../../src/approvals.ts';
import type { InMemoryOptions } from '../../src/storage/memory.ts';
import { checkerFixture, currentCheck } from './checker-fixtures.ts';
import { wrapStore } from './api-fixtures.ts';
export class FictionalSnapshotReferences implements LogicModelReferenceProvider {
  objects = new Map<string, Buffer>();
  calls = 0;
  async getVerifiedReference(snapshot: LogicModelSnapshot): Promise<VerifiedLogicModelReference> {
    this.calls++;
    const bytes = logicObjectBytes(snapshot), uri = `s3://fictional-local-snapshots/snapshots/${snapshot.snapshotHash}.json`;
    const old = this.objects.get(uri);
    if (old && !old.equals(bytes)) throw Error('Fictional immutable object conflict');
    this.objects.set(uri, Buffer.from(bytes)); // simulated S3-first immutable write
    assert.equal(createHash('sha256').update(this.objects.get(uri)!).digest('hex'), snapshot.snapshotHash);
    return { requestPreview: { ...snapshot.requestPreview }, logic: { logicRevision: snapshot.revision, logicHash: snapshot.snapshotHash }, uri,
      versionId: 'fictional-object-version-1', verificationId: 'fictional-byte-verification', representation: LOGIC_OBJECT_FORMAT,
      hashPolicyVersion: snapshot.hashPolicyVersion, byteSha256: snapshot.snapshotHash, byteLength: bytes.length };
  }
}
export async function compilationFixture(options: Partial<InMemoryOptions> = {}, decision: 'APPROVE' | 'REJECT' | 'RETURN' | null = 'APPROVE') {
  const f = await currentCheck(checkerFixture(options));
  assert.equal((await f.service.ingest(f.c, f.r4)).status, 'ACCEPTED');
  const s = (await f.db.getWorkflow(f.c.requestId))!;
  const approvals = new ApprovalService({ store: f.db, resolveActor: f.resolveActor });
  if (decision) assert.equal((await approvals.execute({ type: 'CLINICAL_DECISION', requestId: f.c.requestId, eventId: 'fictional-clinical-approval',
    expectedVersion: s.version, requestRevision: s.brief.revision, requestSnapshotHash: s.brief.snapshotHash, ...s.logic!, checkerReportId: s.checks!.reportId,
    decision, ...(decision !== 'APPROVE' ? { note: 'Fictional training correction requested.' } : {}) }, 'clinic')).status, 'SUCCESS');
  const current = (await f.db.getWorkflow(f.c.requestId))!, references = new FictionalSnapshotReferences();
  const deps: CompilationHandoffDependencies = { store: f.db, resolveActor: f.resolveActor, canAccessRequest: f.canAccessRequest,
    snapshotReferences: references, now: () => '2026-11-04T12:00:00.000Z' };
  const command: CompilationCommand = { requestId: current.brief.requestId, revision: current.brief.revision, snapshotHash: current.brief.snapshotHash,
    eventId: 'fictional-start-compilation', expectedVersion: current.version, logicModelRevision: current.logic!.logicRevision,
    logicModelHash: current.logic!.logicHash, clinicalApprovalId: 'fictional-clinical-approval' };
  return { ...f, approvals, current, references, compileDeps: deps, compile: new CompilationHandoffService(deps), command };
}
export function wrapCompilationStore(db: CompilationStore, overrides: Partial<CompilationStore>): CompilationStore {
  return { ...wrapStore(db, {}), getCompilationJob: (id, job) => db.getCompilationJob(id, job), listCompilationJobs: id => db.listCompilationJobs(id),
    getCompilationOutbox: (id, job) => db.getCompilationOutbox(id, job), ...overrides };
}
