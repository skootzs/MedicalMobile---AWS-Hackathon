import { serializeRequirements } from '../../../intake/intake.js'
import { draftLogicModel } from '../../../drafter/src/draft.ts'
import { checkLogicModel } from '../../../checker/src/check.ts'
import { validateGoldenCases, validateLogicModel } from '../../../schema/src/validate.ts'
import { canonicalizeJson, provisionalSnapshotValidator } from '../snapshots.ts'
import { screeningAreas } from '../routing.ts'
import { runnerPrincipalForJob } from '../job-events.ts'
import { readVerified, sha256, writeVerified } from '../storage/durable-objects.ts'
import { EvidenceError } from './artifacts.js'

const checkerTarget = { checkerActorId: 'pipeline-checker', checkerId: 'deterministic-checker', checkerVersion: '0.1.0' }
const complete = new Set(['RELEASE_APPROVED', 'DOWNLOAD_READY', 'FAILED', 'REJECTED', 'RETURNED_FOR_CLARIFICATION'])

export function pipelineIdentity() {
  const actors = new WeakMap()
  const principal = (id, role, requestId) => {
    const token = {}
    actors.set(token, { actor: { id, roles: [role] }, requestId })
    return token
  }
  return {
    principal,
    resolve(token, requestId) {
      const record = actors.get(token)
      return record && (record.requestId === requestId || record.requestId === null) ? record.actor : null
    }
  }
}

export const checkerPolicies = {
  checkerTarget,
  draftingValidation: {
    validateSnapshot(content, context) {
      provisionalSnapshotValidator(content, context)
      if (context.kind === 'LOGIC_MODEL' && !validateLogicModel(content).ok) throw new Error('INVALID_LOGIC_MODEL')
    },
    async validateProposal(snapshot) {
      if (!validateLogicModel(snapshot.content).ok) return { status: 'FAILED' }
      return {
        status: 'PASSED', validatorId: 'logic-model-schema', validatorVersion: '1',
        resultId: `schema-${snapshot.snapshotHash}`, requestId: snapshot.requestId,
        requestPreview: snapshot.requestPreview,
        logic: { logicRevision: snapshot.revision, logicHash: snapshot.snapshotHash },
        schemaVersion: snapshot.schemaVersion, hashPolicyVersion: snapshot.hashPolicyVersion
      }
    }
  }
}

const later = (stage, fields = {}, delay = 0) => ({ stage, attempts: 0, due: Date.now() + delay, ...fields })
const finished = (stage, reason = null) => ({ stage, reason, due: null })
const hashJson = value => sha256(Buffer.from(canonicalizeJson(value)))

function resultOf(result, ...statuses) {
  if (!statuses.includes(result.status)) throw new Error(result.reason)
  return result
}

export function createPipeline({ intake, review, screening, registry, catalog, readPinned, drafter,
  server, identity, runnerRecord, log = () => {} }) {
  const { store, objects, requests, routing, drafting, compile, verify } = server.automation
  const { draftingCallback, checkerResults, reconciler } = server.services

  async function handle(item) {
    const { author, requestId, revisionId } = item
    const key = [author, requestId, revisionId]
    if (item.stage === 'screen') {
      if (!await intake.current(...key)) return finished('superseded')
      const previous = await review.get(...key)
      if (['needs_clarification', 'screening_blocked'].includes(previous.status) ||
          (previous.status === 'screening_failed' && !previous.retryable)) return finished('screened')
      if (previous.status === 'screening' && !previous.leaseExpired) return later('screen', { attempts: item.attempts }, 5000)
      const state = previous.status === 'screening_passed' ? previous : await review.screen(...key, { automatic: true })
      if (state.status === 'screening_passed') await review.preview(...key)
      if (state.retryable) throw new Error('SCREENING_UNAVAILABLE')
      return finished('screened')
    }

    if (item.stage === 'dispatch') {
      const [revision, phase, current] = await Promise.all([
        intake.revision(...key), intake.phase(...key), intake.current(...key)
      ])
      if (!current) return finished('superseded')
      const snapshot = phase?.outbox?.snapshot
      const preview = phase?.preview
      const confirmation = phase?.confirmation
      if (!revision || revision.screeningStatus !== 'pending_screening' || revision.corrections.length ||
          phase?.status !== 'screening_passed' || phase.policy !== screening.fingerprint ||
          phase.rejection || !snapshot || !preview || !confirmation ||
          confirmation.authorId !== author || confirmation.revisionId !== revisionId ||
          confirmation.attemptId !== phase.attemptId || confirmation.previewId !== preview.id ||
          confirmation.previewHash !== preview.hash || preview.revisionId !== revisionId ||
          preview.attemptId !== phase.attemptId ||
          hashJson(snapshot.confirmation) !== hashJson(confirmation) ||
          snapshot.preview?.id !== preview.id || snapshot.preview.hash !== preview.hash ||
          snapshot.screening?.attemptId !== phase.attemptId || snapshot.screening.policy !== phase.policy ||
          snapshot.requestId !== requestId || snapshot.revisionId !== revisionId || snapshot.authorId !== author ||
          snapshot.requirementsHash !== revision.requirementsHash || snapshot.baselineHash !== revision.baselineHash ||
          hashJson(snapshot.normalizedRequirements) !== hashJson(revision.normalizedRequirements) ||
          hashJson(snapshot.sources) !== hashJson(revision.sources) ||
          sha256(Buffer.from(serializeRequirements(revision.normalizedRequirements))) !== revision.requirementsHash ||
          registry[revision.baselineVersion] !== revision.baselineHash) throw new EvidenceError('STALE_INTAKE_EVIDENCE')
      const entry = catalog.get(JSON.stringify([revision.normalizedRequirements.pathway.trim().toLowerCase(), revision.baselineVersion]))
      if (!entry || entry.baselineHash !== revision.baselineHash) throw new EvidenceError('EVIDENCE_BUNDLE_MISSING')
      for (const ref of revision.sources) {
        if (sha256(await intake.readSource(ref)) !== ref.sha256) throw new EvidenceError('INTAKE_SOURCE_MISMATCH')
      }
      const [guideline, cases] = await Promise.all([
        readPinned(entry.guideline, 'sources'), readPinned(entry.goldenCases, 'sources')
      ])
      const golden = parseGolden(cases)
      if (!guideline.toString('utf8').trim() || !golden.length) throw new EvidenceError('EVIDENCE_BUNDLE_INVALID')
      const binding = { snapshot, evidence: entry }
      const saved = await intake.saveWork(item, later('create', { binding, fingerprint: hashJson(binding) }), phase)
      if (!saved) throw new Error('INTAKE_ACCEPTANCE_CONFLICT')
      log({ revisionId, stage: 'create', queuedMs: Date.now() - item.queuedAt })
      return null
    }

    const binding = item.binding
    if (hashJson(binding) !== item.fingerprint) throw new EvidenceError('HANDOFF_FINGERPRINT_MISMATCH')
    const { snapshot, evidence } = binding
    const { pathway, goal, targetUsers, acceptanceCriteria } = snapshot.normalizedRequirements
    const po = identity.principal(author, 'PO', item.workflowId ?? null)
    if (item.stage === 'create') {
      const created = resultOf(await requests.create({ eventId: revisionId, expectedVersion: 0, content: {
        title: pathway, objective: goal, targetPopulation: targetUsers, intakeEvidenceHash: item.fingerprint,
        requirements: [{ condition: goal, action: acceptanceCriteria }]
      } }, po), 'SUCCESS', 'DUPLICATE_EVENT')
      return later('draft', { workflowId: created.requestId })
    }

    const id = item.workflowId
    const state = await store.getWorkflow(id)
    if (!state || state.ownerId !== author) throw new EvidenceError('WORKFLOW_LINK_INVALID')
    if (complete.has(state.status)) return finished(state.status)
    const request = { requestId: id, revision: state.brief.revision, snapshotHash: state.brief.snapshotHash }
    const command = { ...request, expectedVersion: state.version }
    const drafterActor = identity.principal('pipeline-drafter', 'DRAFTER', id)
    const orchestrator = identity.principal('pipeline-orchestrator', 'ORCHESTRATOR', id)
    const checker = identity.principal(checkerTarget.checkerActorId, 'CHECKER', id)

    if (item.stage === 'draft') {
      const guideline = await readPinned(evidence.guideline, 'sources')
      const result = await draftLogicModel({
        guidelineMarkdown: new TextDecoder('utf-8', { fatal: true }).decode(guideline),
        request: canonicalizeJson(snapshot.normalizedRequirements),
        client: drafter
      })
      const bytes = Buffer.from(JSON.stringify(result))
      const draft = await writeVerified(objects, `previews/${sha256(bytes)}.json`, bytes)
      if (!result.logic) return { ...finished('blocked', result.envelope.blockers[0]?.kind ?? 'DRAFT_BLOCKED'), draft }
      return later('workflow', { draft })
    }

    switch (state.status) {
      case 'WAITING_FOR_SCREENING': {
        const { envelope } = JSON.parse(await readVerified(objects, item.draft))
        const checks = Object.fromEntries(screeningAreas.map(area => [area, envelope.screening[area].status === 'pass'
          ? { outcome: 'CLEAR', reasons: [] }
          : { outcome: 'NEEDS_REVIEW', reasons: [envelope.screening[area].detail] }]))
        resultOf(await requests.recordScreening({ ...command, eventId: `screen-${revisionId}`, screening: {
          ...request, screeningId: snapshot.screening.attemptId, status: 'COMPLETED', checks
        } }, drafterActor), 'SUCCESS', 'DUPLICATE_EVENT')
        break
      }
      case 'WAITING_FOR_PO_CONFIRMATION':
        resultOf(await requests.confirm({ ...command, eventId: snapshot.confirmation.id,
          screeningId: snapshot.screening.attemptId, decision: 'CONFIRMED' }, po), 'SUCCESS', 'DUPLICATE_EVENT')
        break
      case 'READY_TO_ROUTE':
        resultOf(await routing.execute({ ...command, eventId: `route-${revisionId}` }, orchestrator), 'SUCCESS', 'DUPLICATE_EVENT')
        break
      case 'READY_FOR_LOGIC_PROPOSAL':
        resultOf(await drafting.start({ ...command, eventId: `draft-${revisionId}`,
          routingEventId: `route-${revisionId}` }, orchestrator), 'INTENT_RECORDED', 'DUPLICATE_EVENT')
        break
      case 'DRAFTING_LOGIC': {
        const receipt = await store.getReceipt(id, `draft-${revisionId}`)
        const job = receipt?.jobId && await store.getJob(id, receipt.jobId)
        if (!job) throw new Error('DRAFT_JOB_MISSING')
        const { logic } = JSON.parse(await readVerified(objects, item.draft))
        resultOf(await draftingCallback.ingest({ ...command, eventId: `propose-${revisionId}`, jobId: job.jobId,
          sourceWorkflowVersion: job.sourceWorkflowVersion, schemaVersion: logic.schemaVersion, logicModel: logic
        }, drafterActor), 'ACCEPTED', 'DUPLICATE_EVENT')
        break
      }
      case 'WAITING_FOR_LOGIC_CHECKS': {
        const model = await store.getSnapshot({ kind: 'LOGIC_MODEL', requestId: id,
          revision: state.logic.logicRevision, requestPreview: request })
        if (!model) throw new Error('LOGIC_SNAPSHOT_MISSING')
        const cases = parseGolden(await readPinned(evidence.goldenCases, 'sources'))
        const checked = checkLogicModel(model.content, cases)
        const { invocation } = resultOf(await checkerResults.authorize({ ...command, ...state.logic,
          eventId: `authorize-${revisionId}` }, orchestrator), 'AUTHORIZED', 'DUPLICATE_EVENT')
        resultOf(await checkerResults.ingest({ ...command, ...state.logic, eventId: `checked-${revisionId}`,
          invocationId: invocation.invocationId, report: {
            ...checked, reportId: `report-${revisionId}`, resultId: `result-${revisionId}`, requestId: id,
            requestPreview: request, logic: state.logic, invocationId: invocation.invocationId,
            checkerId: invocation.checkerId, checkerVersion: invocation.checkerVersion,
            references: [evidence.goldenCases.sha256]
          }
        }, checker), 'ACCEPTED', 'DUPLICATE_EVENT')
        break
      }
      case 'CLINICALLY_APPROVED':
        resultOf(await compile.start({ ...command, eventId: `compile-${revisionId}`,
          logicModelRevision: state.logic.logicRevision, logicModelHash: state.logic.logicHash,
          clinicalApprovalId: state.clinicalApproval.eventId }, orchestrator), 'INTENT_RECORDED', 'DUPLICATE_EVENT')
        break
      case 'WAITING_FOR_VERIFICATION': {
        const bytes = await readPinned(evidence.goldenCases, 'sources')
        const { uri, sha256 } = await writeVerified(objects, `sources/${evidence.goldenCases.sha256}.json`, bytes)
        resultOf(await verify.start({ ...command, eventId: `verify-${revisionId}`,
          logicModelRevision: state.logic.logicRevision, logicModelHash: state.logic.logicHash,
          compileJobId: state.artifact.compilationId }, orchestrator, { uri, sha256 }), 'INTENT_RECORDED', 'DUPLICATE_EVENT')
        break
      }
      case 'COMPILING':
      case 'VERIFYING': {
        const jobId = state.compilationId && state.status === 'COMPILING' ? state.compilationId : state.verificationId
        const row = jobId && await runnerRecord(jobId)
        if (!row || !['SUCCEEDED', 'FAILED', 'EXHAUSTED', 'TIMED_OUT'].includes(row.status)) {
          if (row?.createdAt && Date.now() - Date.parse(row.createdAt) > 45 * 60_000) {
            return finished('blocked', 'BUILD_RESULT_TIMEOUT')
          }
          return later('workflow', {}, 5000)
        }
        const result = await reconciler.reconcile({ requestId: id, jobId, attempt: row.attempt,
          jobType: row.jobType }, runnerPrincipalForJob(row.jobType))
        resultOf(result, 'RECONCILED', 'DUPLICATE')
        break
      }
      case 'NEEDS_SD_REVIEW':
      case 'WAITING_FOR_CLINICAL_APPROVAL':
      case 'WAITING_FOR_RELEASE_APPROVAL':
        return later('workflow', {}, 5000)
      default:
        throw new Error('UNSUPPORTED_WORKFLOW_STATE')
    }
    return later('workflow', {}, 1000)
  }

  return {
    async tick() {
      for await (const due of intake.dueWork(Date.now())) {
        const item = await intake.claimWork(due, Date.now())
        if (!item) continue
        let next
        try {
          next = await handle(item)
        } catch (error) {
          const attempts = item.attempts + 1
          const reason = /^[A-Z][A-Z_0-9]{0,99}$/.test(error.message) ? error.message : 'PIPELINE_UNAVAILABLE'
          next = error instanceof EvidenceError || attempts >= 5 ? finished('blocked', reason) :
            later(item.stage, { attempts }, Math.min(60_000, 1000 * 2 ** attempts))
          log({ revisionId: item.revisionId, stage: item.stage, reason, attempts, retry: next.due !== null })
        }
        if (next && await intake.saveWork(item, next) && next.stage !== item.stage) {
          log({ revisionId: item.revisionId, stage: next.stage, queuedMs: Date.now() - item.queuedAt })
        }
      }
    }
  }
}

function parseGolden(bytes) {
  let cases
  try { cases = JSON.parse(bytes) } catch { throw new EvidenceError('GOLDEN_CASES_INVALID') }
  if (!Array.isArray(cases) || !cases.length || !validateGoldenCases(cases).ok) throw new EvidenceError('GOLDEN_CASES_INVALID')
  return cases
}

export function evidenceCatalog(entries) {
  if (!Array.isArray(entries)) throw new EvidenceError('INVALID_EVIDENCE_CATALOG')
  const catalog = new Map()
  for (const entry of entries) {
    if (typeof entry.pathway !== 'string' || !entry.pathway.trim() || typeof entry.baselineVersion !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry.baselineHash)) throw new EvidenceError('INVALID_EVIDENCE_CATALOG')
    const key = JSON.stringify([entry.pathway.trim().toLowerCase(), entry.baselineVersion])
    if (catalog.has(key)) throw new EvidenceError('DUPLICATE_EVIDENCE_BUNDLE')
    catalog.set(key, entry)
  }
  return catalog
}
