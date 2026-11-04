/**
 * Approved-artifact access for R1. Read-only: it exposes the release artifact
 * reference ONLY when the workflow has reached RELEASE_APPROVED or
 * DOWNLOAD_READY, and never otherwise. It duplicates no business logic — release
 * eligibility is decided by the workflow/ApprovalService; this handler only
 * reports what the authoritative state already approved.
 *
 * Authentication + request-level access are applied by the server factory
 * before this handler runs (the same guards as every other request route).
 *
 * It returns the bound identities (packageHash, manifestHash, reportHash,
 * verificationId, compilationId) plus the immutable S3 object reference of the
 * package (uri/versionId/sha256), read from the accepted compilation result —
 * the workflow state itself carries no URIs. It does NOT stream bytes or mint a
 * download URL; R1/R7 own actual delivery.
 */
import type { FastifyInstance } from 'fastify';
import { emptyQuerySchema, errorResponses, hashSchema, identifierSchema, notFound, paramsSchema, unavailable } from './http.ts';
import type { RequestParams } from './http.ts';
import type { VerificationResultStore } from '../storage/verification-results.ts';
import type { CompilationResultStore } from '../storage/compilation-results.ts';

const objectRefSchema = {
  type: 'object', additionalProperties: false, required: ['uri', 'versionId', 'sha256', 'size'],
  properties: { uri: { type: 'string' }, versionId: { type: 'string' }, sha256: hashSchema, size: { type: 'integer', minimum: 1 } },
};
const responseSchema = {
  type: 'object', additionalProperties: false,
  required: ['requestId', 'status', 'released', 'compilationId', 'artifactHash', 'manifestHash', 'verificationId', 'reportHash', 'package'],
  properties: {
    requestId: { type: 'string' }, status: { type: 'string' }, released: { type: 'boolean', const: true },
    compilationId: identifierSchema, artifactHash: hashSchema, manifestHash: hashSchema,
    verificationId: identifierSchema, reportHash: hashSchema,
    package: objectRefSchema, manifest: objectRefSchema, report: objectRefSchema,
  },
};

/** Store that can read both the verification result and the compiled artifact. */
type ArtifactStore = VerificationResultStore & CompilationResultStore;

export function registerDownloadRoute(app: FastifyInstance, store: ArtifactStore) {
  app.get<{ Params: RequestParams }>('/api/requests/:requestId/artifact', {
    schema: { params: paramsSchema, querystring: emptyQuerySchema, response: { 200: responseSchema, ...errorResponses } },
  }, async (request, reply) => {
    try {
      const state = await store.getWorkflow(request.params.requestId);
      // Only an approved release is ever exposed. Anything earlier is "not found"
      // so an unapproved artifact can never be retrieved as a released download.
      if (!state || !['RELEASE_APPROVED', 'DOWNLOAD_READY'].includes(state.status) ||
          !state.releaseApproval || !state.verification?.passed || !state.artifact) return notFound(reply);
      // Package/manifest object references live only in the accepted compilation result.
      const result = await store.getCompilationResult(state.brief.requestId, state.artifact.compilationId);
      if (!result || result.outcome !== 'COMPILED' || !result.artifact ||
          result.artifact.packagedObject.sha256 !== state.artifact.artifactHash) return unavailable(reply);
      return {
        requestId: state.brief.requestId, status: state.status, released: true,
        compilationId: state.artifact.compilationId, artifactHash: state.artifact.artifactHash,
        manifestHash: result.artifact.manifest.sha256,
        verificationId: state.verification.verificationId, reportHash: state.verification.reportHash,
        package: result.artifact.packagedObject, manifest: result.artifact.manifest, report: result.artifact.report,
      };
    } catch { return unavailable(reply); }
  });
}
