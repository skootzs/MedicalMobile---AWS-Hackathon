import { randomUUID } from 'node:crypto'
import { HttpError, hash, serializeRequirements, submit } from './intake.js'
import { applySuggestions } from './suggestions.js'
import { ScreeningBlock, validateResult } from './screening.js'

const blockedMessages = {
  SOURCE_INTEGRITY: 'Source evidence could not be verified. Submit a new revision.',
  INPUT_TOO_LARGE: 'Shorten the request or use a smaller optional guideline excerpt.',
  GUARDRAIL_INTERVENED: 'Screening stopped on a content check. Use public or synthetic guideline text and remove embedded instructions.'
}

export function createReview({ store, registry, config, screen, now = Date.now }) {
  const leaseMs = 180000
  const currentPolicy = state => state?.policy === config.fingerprint
  async function revision(author, requestId, revisionId) {
    const value = await store.revision(author, requestId, revisionId)
    if (!value) throw new HttpError(404, 'Request not found.')
    return value
  }
  async function save(author, r, previous, next, event, requireCurrent = false) {
    const saved = await store.savePhase(author, r.requestId, r.revisionId, previous, next, event, requireCurrent)
    if (!saved) throw new HttpError(409, 'This revision changed or another operation is running. Refresh and try again.')
    return saved
  }
  function publicState(state) {
    if (!state) return { status: 'pending_screening', enabled: config.enabled }
    if (!currentPolicy(state)) return { status: 'pending_screening', enabled: config.enabled, message: 'Screening settings changed. Screen this revision again.' }
    return { status: state.status, enabled: config.enabled, attemptId: state.attemptId,
      result: state.result || null, message: state.message || null, preview: state.preview || null,
      rejection: state.rejection || null, confirmed: Boolean(state.confirmation), handoff: state.outbox ? 'queued' : null,
      retryable: state.status === 'screening_failed' && state.retryable === true,
      leaseExpired: state.status === 'screening' && state.leaseUntil <= now() }
  }
  return {
    async get(author, requestId, revisionId) {
      const r = await revision(author, requestId, revisionId)
      if (r.screeningStatus === 'blocked') return { status: 'blocked', enabled: config.enabled }
      return publicState(await store.phase(author, requestId, revisionId))
    },
    async screen(author, requestId, revisionId) {
      const r = await revision(author, requestId, revisionId)
      if (!config.enabled) throw new HttpError(503, 'Screening is not enabled yet.')
      if (r.screeningStatus !== 'pending_screening') throw new HttpError(409, 'Correct the local validation issues first.')
      const previous = await store.phase(author, requestId, revisionId)
      if (previous?.confirmation) throw new HttpError(409, 'This revision is already confirmed. Submit a correction to screen it again.')
      if (previous?.status === 'screening' && previous.leaseUntil > now()) return publicState(previous)
      const attemptId = randomUUID()
      const active = await save(author, r, previous, {
        status: 'screening', attemptId, policy: config.fingerprint, leaseUntil: now() + leaseMs
      }, { type: 'screening_started', attemptId, policy: config })
      let completion
      try {
        if (hash(serializeRequirements(r.normalizedRequirements)) !== r.requirementsHash ||
            registry[r.baselineVersion] !== r.baselineHash) throw new ScreeningBlock('SOURCE_INTEGRITY')
        const guidelines = []
        for (const source of r.sources) {
          let bytes
          try { bytes = await store.readSource(source) } catch (error) {
            if (['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes(error.name)) throw new ScreeningBlock('SOURCE_INTEGRITY')
            throw error
          }
          if (hash(bytes) !== source.sha256) throw new ScreeningBlock('SOURCE_INTEGRITY')
          if (source.filename) guidelines.push({ source: source.key, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) })
        }
        const requirementsSource = r.sources.find(source => source.key.endsWith('/submission.json'))?.key
        if (!requirementsSource) throw new ScreeningBlock('SOURCE_INTEGRITY')
        const input = { requirements: r.normalizedRequirements, requirementsSource,
          ...(previous?.rejection && { previewFeedback: previous.rejection.feedback }),
          baselineVersion: r.baselineVersion, guidelineUrls: r.references.map(reference => reference.url), guidelines }
        if (Buffer.byteLength(JSON.stringify(input)) > config.maxInputBytes) throw new ScreeningBlock('INPUT_TOO_LARGE')
        const output = await screen(input)
        const result = validateResult(output.result, [requirementsSource, ...guidelines.map(item => item.source)], r.normalizedRequirements)
        completion = { status: result.decision === 'pass' ? 'screening_passed' : 'needs_clarification',
          result, requestId: output.requestId || null, usage: output.usage || null }
      } catch (error) {
        const blocked = error instanceof ScreeningBlock
        const retryable = !blocked && ['ThrottlingException', 'ServiceUnavailableException', 'InternalServerException',
          'ModelTimeoutException', 'ModelNotReadyException', 'TimeoutError', 'AbortError'].includes(error.name)
        completion = { status: blocked ? 'screening_blocked' : 'screening_failed', retryable,
          failureCode: blocked ? error.message : error.name,
          message: blocked ? blockedMessages[error.message] : retryable
            ? 'Screening is temporarily unavailable. Retry this revision.' : 'Screening could not complete. Ask the service administrator to check the configuration or model response.' }
      }
      // Compare-and-swap prevents an expired attempt from overwriting a newer one.
      const complete = await save(author, r, active, { ...active, ...completion, leaseUntil: 0 }, {
        type: 'screening_completed', attemptId, ...completion,
        evidenceBinding: { requirementsHash: r.requirementsHash, baselineHash: r.baselineHash, sources: r.sources }
      })
      return publicState(complete)
    },
    async preview(author, requestId, revisionId) {
      const r = await revision(author, requestId, revisionId)
      const previous = await store.phase(author, requestId, revisionId)
      if (!config.enabled || !currentPolicy(previous) || previous?.status !== 'screening_passed') throw new HttpError(409, 'Screen this revision before previewing it.')
      if (previous.rejection) throw new HttpError(409, 'This preview was rejected. Submit a correction before previewing again.')
      if (previous.preview) return publicState(previous)
      // A deterministic request summary; clinical pathway drafting occurs downstream.
      const content = { requirements: r.normalizedRequirements, baselineVersion: r.baselineVersion,
        sources: r.sources.filter(source => source.filename), summary: previous.result.summary }
      const preview = { id: randomUUID(), hash: hash(JSON.stringify(content)), revisionId, attemptId: previous.attemptId, content }
      return publicState(await save(author, r, previous, { ...previous, preview }, { type: 'preview_created', preview }, true))
    },
    async reject(author, requestId, revisionId, input) {
      const r = await revision(author, requestId, revisionId)
      const previous = await store.phase(author, requestId, revisionId)
      if (!input || Object.keys(input).some(key => !['attemptId', 'previewId', 'previewHash', 'feedback'].includes(key)) ||
          typeof input.feedback !== 'string' || !input.feedback.trim() || input.feedback.length > 4000) throw new HttpError(400, 'Explain what needs to change in the preview.')
      if (!config.enabled || !currentPolicy(previous) || previous?.status !== 'screening_passed' || previous.confirmation ||
          input.attemptId !== previous.attemptId || input.previewId !== previous.preview?.id || input.previewHash !== previous.preview?.hash) {
        throw new HttpError(409, 'Reject the current, unconfirmed preview.')
      }
      const rejection = { ...input, authorId: author, at: new Date(now()).toISOString() }
      return publicState(await save(author, r, previous, { ...previous, rejection }, { type: 'preview_rejected', rejection }, true))
    },
    async revise(author, requestId, revisionId, input, key) {
      const r = await revision(author, requestId, revisionId)
      const previous = await store.phase(author, requestId, revisionId)
      if (!/^[\w-]{16,128}$/.test(key ?? '')) throw new HttpError(400, 'Provide a valid idempotency key.')
      if (!input || Object.keys(input).some(key => !['attemptId', 'selections'].includes(key))) throw new HttpError(400, 'Provide selected suggestions.')
      if (!config.enabled || !currentPolicy(previous) || !['screening_passed', 'needs_clarification'].includes(previous?.status) ||
          previous.confirmation || input.attemptId !== previous.attemptId) throw new HttpError(409, 'Review suggestions from the current screening first.')
      const requirements = applySuggestions(r.normalizedRequirements, previous.result.suggestions || [], input.selections)
      const payload = { ...requirements, baselineVersion: r.baselineVersion,
        guidelineUrls: r.references.filter(item => item.source.endsWith('/submission.json')).map(item => item.url) }
      const attachment = r.sources.find(source => source.filename)
      if (attachment) {
        const bytes = await store.readSource(attachment)
        if (hash(bytes) !== attachment.sha256) throw new HttpError(409, 'Source evidence changed. Submit a manual correction.')
        payload.attachment = { name: attachment.filename, base64: Buffer.from(bytes).toString('base64') }
      }
      // Bind author choices to this immutable attempt before creating the new revision.
      const selectedState = await save(author, r, previous, previous, { type: 'revision_suggestions_selected', attemptId: previous.attemptId,
        selections: input.selections, rejectedPreviewId: previous.rejection?.previewId || null })
      return submit({ store, registry, author, requestId, key, raw: Buffer.from(JSON.stringify(payload)),
        commitGuard: { revisionId, phaseVersion: selectedState.version } })
    },
    async confirm(author, requestId, revisionId, input) {
      const r = await revision(author, requestId, revisionId)
      const previous = await store.phase(author, requestId, revisionId)
      if (!input || Object.keys(input).some(key => !['previewId', 'previewHash', 'attemptId', 'feedback'].includes(key)) ||
          typeof input.feedback !== 'string' || input.feedback.length > 4000) throw new HttpError(400, 'Provide valid preview feedback.')
      if (!config.enabled || !currentPolicy(previous) || previous?.status !== 'screening_passed' || previous.rejection ||
          input.previewId !== previous.preview?.id || input.previewHash !== previous.preview?.hash ||
          input.attemptId !== previous.attemptId) throw new HttpError(409, 'Review the current preview before confirming.')
      const confirmation = previous.confirmation || { id: randomUUID(), authorId: author, revisionId,
        previewId: input.previewId, previewHash: input.previewHash, attemptId: input.attemptId,
        feedback: input.feedback, at: new Date(now()).toISOString() }
      if (previous.confirmation && previous.confirmation.feedback !== input.feedback) throw new HttpError(409, 'This preview was already confirmed with different feedback.')
      const outbox = previous.outbox || { id: revisionId, status: 'queued', snapshot: {
        ...r, screeningStatus: 'screening_passed', screening: { attemptId: previous.attemptId, policy: config.fingerprint },
        preview: { id: input.previewId, hash: input.previewHash }, confirmation
      } }
      return publicState(await save(author, r, previous, { ...previous, confirmation, outbox }, { type: 'confirmed', confirmation }, true))
    }
  }
}
