import { HttpError } from '../../../intake/intake.js'

const reviewRoute = /^\/api\/(?:reviews\/queue|requests\/req-[0-9a-f]{64}\/(?:review-context|verification-report|clinical-decisions|release-decisions))$/
const decisionRoute = /\/(?:clinical|release)-decisions$/
const stages = {
  WAITING_FOR_SCREENING: 'Drafting clinical logic',
  WAITING_FOR_PO_CONFIRMATION: 'Recording confirmation',
  READY_TO_ROUTE: 'Routing confirmed request',
  READY_FOR_LOGIC_PROPOSAL: 'Preparing clinical draft',
  DRAFTING_LOGIC: 'Drafting clinical logic',
  WAITING_FOR_LOGIC_CHECKS: 'Checking clinical logic',
  NEEDS_SD_REVIEW: 'Needs design clarification',
  WAITING_FOR_CLINICAL_APPROVAL: 'Awaiting clinical approval',
  CLINICALLY_APPROVED: 'Clinical approval recorded',
  COMPILING: 'Compiling CHT configuration',
  WAITING_FOR_VERIFICATION: 'Preparing build verification',
  VERIFYING: 'Verifying build',
  WAITING_FOR_RELEASE_APPROVAL: 'Awaiting release approval',
  RELEASE_APPROVED: 'Approved for download',
  DOWNLOAD_READY: 'Approved for download',
  FAILED: 'Workflow failed a required check',
  REJECTED: 'Rejected',
  RETURNED_FOR_CLARIFICATION: 'Returned for clarification'
}
const blockers = {
  EVIDENCE_BUNDLE_MISSING: 'Ask the administrator to configure curated evidence for this pathway and baseline.',
  INTAKE_SOURCE_MISMATCH: 'The submitted evidence could not be verified. Submit a corrected revision.',
  STALE_INTAKE_EVIDENCE: 'This revision’s evidence or screening policy changed. Submit a corrected revision.',
  SCREENING_UNAVAILABLE: 'Automatic screening exhausted its retries. Use Screen again to retry.',
  BUILD_RESULT_TIMEOUT: 'The build runner has not reported a result. Ask the administrator to check the build queue.',
  schema_failure: 'The drafter did not produce valid clinical logic. Ask the administrator to review the evidence bundle.',
  unusable_source: 'The guideline could not be read. Ask the administrator to check the curated evidence.',
  model_unavailable: 'The drafting service could not complete this revision. Ask the administrator to check its configuration.',
  personal_data: 'A content check stopped drafting. Remove any patient or personal information and submit a correction.',
  COMPILED_ARTIFACT_INTEGRITY: 'The build package did not match the recorded compilation evidence.'
}

export function pipelineHttp({ store, server, readPinned }) {
  async function owner(author, requestId, revisionId) {
    if (!await store.revision(author, requestId, revisionId)) throw new HttpError(404, 'Request not found.')
    const work = await store.work('dispatch', revisionId)
    const screen = await store.work('screen', revisionId)
    if ((work && (work.author !== author || work.requestId !== requestId)) ||
        (screen && (screen.author !== author || screen.requestId !== requestId))) throw new HttpError(404, 'Request not found.')
    const state = work?.workflowId && await server.automation.store.getWorkflow(work.workflowId)
    if (state && state.ownerId !== author) throw new HttpError(404, 'Request not found.')
    return { work, state, screen }
  }

  async function progress(author, requestId, revisionId) {
    const { work, state, screen } = await owner(author, requestId, revisionId)
    const screenBlocked = !work && screen?.stage === 'blocked' &&
      (await store.phase(author, requestId, revisionId))?.status !== 'screening_passed'
    const blocked = work?.stage === 'blocked' ? work : screenBlocked ? screen : null
    if (blocked) return { status: 'blocked', label: 'Needs attention',
      ...(blocked === work && { stoppedAt: state?.stoppedAt ?? state?.status ?? 'queued' }), message: blockers[blocked.reason] ??
      'The pipeline could not continue. Ask the service administrator to check this revision.' }
    if (work?.stage === 'superseded' || screen?.stage === 'superseded') return { status: 'superseded', label: 'Superseded by a correction' }
    if (state) return { status: state.status, label: stages[state.status],
      ...(state.stoppedAt && { stoppedAt: state.stoppedAt }),
      downloadable: Boolean(state.releaseApproval && state.verification?.passed && state.artifact) }
    if (work) return { status: 'queued', label: 'Queued for drafting' }
    return screen?.due ? { status: 'screening', label: 'Automatic screening queued' } : { status: 'intake', label: 'Intake review' }
  }

  return {
    progress,
    async ownerRequest(author, [requestId, revisionId, download], response, send) {
      if (!download) return send(200, await progress(author, requestId, revisionId))
      const { state } = await owner(author, requestId, revisionId)
      if (!state?.releaseApproval || !state.verification?.passed || !state.artifact ||
          !['RELEASE_APPROVED', 'DOWNLOAD_READY'].includes(state.status)) throw new HttpError(404, 'Approved package not found.')
      const result = await server.automation.store.getCompilationResult(state.brief.requestId, state.artifact.compilationId)
      const ref = result?.artifact?.packagedObject
      if (result?.outcome !== 'COMPILED' || ref?.sha256 !== state.artifact.artifactHash) {
        throw new HttpError(503, 'The approved package could not be verified.')
      }
      const bytes = await readPinned(ref, 'builds')
      response.writeHead(200, {
        'Content-Type': 'application/gzip', 'Content-Length': bytes.length, 'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="cht-project.tgz"'
      })
      response.end(bytes)
    },
    async reviewRequest(request, response, readSubmission) {
      const url = new URL(request.url, 'http://localhost')
      const path = url.pathname.replace('/api/workflow/', '/api/')
      const method = decisionRoute.test(path) ? 'POST' : 'GET'
      if (!reviewRoute.test(path) || method !== request.method) throw new HttpError(404, 'Page not found.')
      if (path.endsWith('/verification-report')) {
        const requestId = path.split('/')[3]
        const authorization = request.headers.authorization ?? ''
        const access = await server.app.inject({ method: 'GET', headers: { authorization },
          url: `/api/requests/${requestId}/review-context?category=RELEASE${url.searchParams.has('expectedVersion')
            ? `&expectedVersion=${encodeURIComponent(url.searchParams.get('expectedVersion'))}` : ''}` })
        if (access.statusCode !== 200) {
          response.writeHead(access.statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          return response.end(access.body)
        }
        const review = access.json()
        const result = await server.automation.store.getVerificationResult(requestId, review.verification.verificationId)
        if (!result || result.reportHash !== review.verification.reportHash) throw new HttpError(404, 'Verification report not found.')
        const bytes = await readPinned({ uri: result.reportUri, versionId: result.reportVersionId, sha256: result.reportHash }, 'builds')
        const report = JSON.parse(bytes)
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        return response.end(JSON.stringify({ passed: report.passed, coverageComplete: report.coverageComplete,
          coverage: report.coverage, integrityChecks: report.integrityChecks, caseCount: report.cases.length }))
      }
      const { raw, oversized } = method === 'POST' ? await readSubmission(request) : {}
      if (oversized) throw new HttpError(413, 'The review exceeds the transport limit.')
      const result = await server.app.inject({
        method, url: path + url.search,
        headers: { authorization: request.headers.authorization ?? '', ...(raw ? { 'content-type': 'application/json' } : {}) },
        ...(raw ? { payload: raw } : {})
      })
      response.writeHead(result.statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(result.body)
    }
  }
}
