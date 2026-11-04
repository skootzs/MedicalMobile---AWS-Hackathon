import { digest } from './compilation-result-contracts.ts';
import type { CompilationExecution } from './compilation-result-contracts.ts';

/** R2's intent and the JOB/META row the runner leases both start as PENDING.
 * The runner takes a job only when that status is PENDING. */
export function r7InitialCompilationStatus(status: 'PENDING'): 'PENDING' {
  if (status !== 'PENDING') throw Error('Only an initial R2 intent can be written as PENDING.');
  return 'PENDING';
}
/** Explicit semantic inputs: R7 adapter must establish each wire field's meaning.
 * Legacy R2 execution/workflow artifactHash identifies packaged BYTES; never copy a
 * wire artifactHash into that alias without confirming it is the package digest. */
export function normalizeCompilationHashes(input: { inputHash: string; compileArtifactHash: string; packageHash: string }):
  Pick<CompilationExecution, 'inputHash' | 'compileArtifactHash' | 'artifactHash'> {
  if (![input.inputHash,input.compileArtifactHash,input.packageHash].every(digest)) throw Error('Distinct hash identities must be supplied explicitly.');
  return { inputHash: input.inputHash, compileArtifactHash: input.compileArtifactHash, artifactHash: input.packageHash };
}
