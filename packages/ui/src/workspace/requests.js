import { trackingState } from '../tracking.js'
import { icon } from './icons.js'

export const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
export const receivedAt = revision => revision.events?.[0]?.at || ''
export function latestRequests(revisions) {
  const grouped = new Map()
  for (const revision of [...revisions].sort((a,b) => receivedAt(b).localeCompare(receivedAt(a)) || b.revisionId.localeCompare(a.revisionId))) {
    if (!grouped.has(revision.requestId)) grouped.set(revision.requestId, revision)
  }
  return [...grouped.values()]
}
export function requestStatus(revision, review) {
  if (revision.screeningStatus === 'blocked') return 'blocked'
  if (review?.confirmed) return 'confirmed'
  if (review?.rejection) return 'preview_rejected'
  if (review?.preview) return 'preview_ready'
  return review?.status || 'loading'
}
export const statusLabel = status => ({ confirmed:'Confirmed · handoff queued', preview_ready:'Preview ready', preview_rejected:'Preview rejected', loading:'Loading review state…' })[status] || status.replaceAll('_',' ')
export function nextAction(revision, review) {
  if (review?.workflow?.downloadable) return ['Download approved package','download']
  if (review?.workflow?.status === 'screening' && review.status === 'pending_screening') return ['Screening queued',null]
  if (revision.screeningStatus === 'blocked' || review?.rejection || review?.confirmed || review?.status === 'needs_clarification') return ['Correct request','correct']
  if (!review || !review.enabled) return ['Screening unavailable',null]
  if (review.status === 'screening' && !review.leaseExpired) return ['Refresh screening status','refresh']
  if (review.status !== 'screening_passed') return [review.status === 'pending_screening' ? 'Screen this revision':'Screen again','screening']
  return review.preview ? ['Review and confirm','review'] : ['Create preview','preview']
}
export function renderRequestTimeline(revision, review, {compact=false}={}) {
  if (!review && revision.screeningStatus !== 'blocked') return '<p class="review-loading" role="status">Loading current review state…</p>'
  const model=trackingState(revision,review), e=escapeText
  const progress = model.completed ? 'Workflow complete' : `Stage ${model.current + 1} of ${model.steps.length}`
  const steps=model.steps.map((step,index)=>({...step,index})).filter(step=>!compact || step.index<=model.current)
  return `<section class="protocol-timeline ${compact?'compact-timeline':''}" aria-label="Request progress"><header class="timeline-heading"><div><h2>Workflow timeline</h2><p>${review?.workflow ? 'Progress for this request revision.' : 'Saved request and current intake review.'}</p></div><span>${progress}</span></header><ol class="protocol-stages">${steps.map(step=>`<li class="protocol-stage ${step.state}" ${step.index===model.current&&!model.completed?'aria-current="step"':''}><span class="workflow-marker" aria-hidden="true">${step.state==='complete'?icon('check'):String(step.index+1).padStart(2,'0')}</span><div class="workflow-stage-copy"><h3>${e(step.label)}</h3><p>${e(step.description)}</p></div><div class="workflow-stage-meta"><strong>${({complete:'Completed',current:'Current',attention:'Needs attention',upcoming:'Upcoming'})[step.state]}</strong></div></li>`).join('')}</ol>${compact?`<div class="timeline-expand-link"><a class="text-link" href="/requests/${e(revision.requestId)}">View request tracking ${icon('arrow')}</a></div>`:''}</section>`
}
export function renderRequestTracking(revision, review) {
  if(review?.loadError)return `<section class="protocol-status-card"><div class="info-card"><h2>Current review unavailable</h2><p>${escapeText(review.message)}</p><button type="button" class="button" data-request-next="reload">Retry loading request</button></div></section>`
  const model=trackingState(revision,review), e=escapeText
  const [label,action]=nextAction(revision,review)
  const progress = model.completed ? 'Workflow complete' : `Stage ${model.current + 1} of ${model.steps.length}`
  return `<section class="protocol-status-card ${model.attention?'needs-changes':''}"><div class="protocol-status-main"><div><p class="status-eyebrow">${icon('clock')}Current status</p><h2>${e(review?.workflow ? model.headline : review?.confirmed ? 'Request confirmed. Handoff queued.' : model.headline)}</h2><p>${e(model.steps[model.current].description)}</p></div><section class="protocol-with-now"><p class="status-eyebrow">Request owner</p><h3>Signed-in product owner</h3><p>PO review of requirements</p><span>${review?.workflow ? e(review.workflow.label) : 'No clinical approval recorded'}</span></section></div><div class="protocol-progress"><div class="progress-caption"><strong>${progress}</strong><span>${review?.workflow?.downloadable ? 'Approved package available below' : 'No release available'}</span></div><div class="protocol-progress-segments request-segments" role="img" aria-label="${progress}">${model.steps.map(step=>`<span class="${step.state}"></span>`).join('')}</div></div></section><div class="workspace-grid protocol-tracking-grid">${renderRequestTimeline(revision,review)}<aside class="information-rail protocol-tracking-rail"><section class="info-card protocol-next-card"><h3>${icon('circle-arrow')}What happens next</h3><p>${e(review?.message || model.steps[model.current].description)}</p><button type="button" class="button primary" data-request-next="${action||''}" ${action==='screening'?`data-screening-revision="${e(revision.revisionId)}"`:''} ${action?'':'disabled'}>${e(label)}</button><p class="action-audience">Completeness screening does not validate clinical correctness.</p></section><section class="info-card"><h3>Request details</h3><dl><div class="meta-pair"><dt>Baseline</dt><dd>${e(revision.baselineVersion)}</dd></div><div class="meta-pair"><dt>Revision</dt><dd>${e(revision.revisionId)}</dd></div></dl></section><section class="release-locked"><div>${review?.workflow
    ? `<h3>${e(review.workflow.label)}</h3><p>${e(review.workflow.message || (review.workflow.downloadable ? 'Use the download button in this revision’s details.' : 'Download becomes available after verification and release approval.'))}</p>`
    : '<h3>Downstream services unavailable</h3><p>Clinical approval, configuration building, testing, and release download are not connected.</p><button type="button" disabled>Download unavailable</button>'}</div></section></aside></div>`
}

// Reads only. Model calls must remain explicit user actions in the intake controller.
export async function loadReviews(revisions, load, onResult, isCurrent=()=>true) {
  let cursor=0
  const worker=async()=>{
    while(cursor<revisions.length && isCurrent()) {
      const revision=revisions[cursor++]
      try { const review=await load(revision); if(isCurrent())onResult(revision,{review}) }
      catch(error) { if(isCurrent())onResult(revision,{error:error.message}) }
    }
  }
  await Promise.all(Array.from({length:Math.min(4,revisions.length)},worker))
}
