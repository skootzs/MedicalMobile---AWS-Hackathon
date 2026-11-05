export function trackingState(revision, state = {}) {
  const blocked = revision.screeningStatus === 'blocked'
  const status = blocked ? 'blocked' : state.status || 'pending_screening'
  const screeningPassed = status === 'screening_passed'
  const preview = screeningPassed && Boolean(state.preview)
  const confirmed = preview && Boolean(state.confirmed)
  const current = state.rejection ? 3 : blocked ? 1 : !screeningPassed ? 2 : !preview ? 3 : !confirmed ? 4 : 5
  const attention = Boolean(state.rejection) || ['blocked', 'needs_clarification', 'screening_blocked', 'screening_failed'].includes(status)
  const labels = ['Request received', 'Intake checks', 'Completeness screening', 'Preview', 'Your confirmation', 'Downstream handoff']
  const descriptions = [
    'Your submission is saved with its own revision record.',
    blocked ? 'Update the required details before this request can move on.' : 'Required details and the configuration baseline have been validated.',
    status === 'needs_clarification' ? 'More information is needed. Submit a corrected revision.'
      : status === 'screening_blocked' ? 'Screening stopped. Review the issues below.'
      : status === 'screening_failed' ? 'Screening could not finish. Review the available actions below.'
      : status === 'screening' ? 'Your requirements are being checked for completeness.'
      : screeningPassed ? 'Completeness screening passed for this revision.'
      : state.enabled === false ? 'Waiting for screening to be enabled.' : 'Waiting for a completeness check.',
    state.rejection ? 'Preview rejected. Use Edit to submit a correction.' : preview ? 'A summary of this exact revision is ready to review.' : 'A request summary can be created after screening passes.',
    confirmed ? 'You confirmed the preview for this revision.' : 'Review the preview and confirm when it reflects your request.',
    confirmed ? 'Queued for downstream drafting. The workflow has not started.' : 'Handoff waits for screening, preview, and confirmation.'
  ]
  return { current, attention, headline: attention ? 'Your request needs attention' : confirmed ? 'Queued for handoff' : labels[current],
    steps: labels.map((label, index) => ({ label, description: descriptions[index],
      state: index < current ? 'complete' : index === current ? attention ? 'attention' : 'current' : 'upcoming' })) }
}
