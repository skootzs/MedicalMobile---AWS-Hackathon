const downstream = [
  ['Clinical drafting', 'The drafter prepares clinical logic from the confirmed request and curated guideline.'],
  ['Logic checks', 'The checker compares the draft with the curated expected results.'],
  ['Clinical approval', 'A clinician reviews the checked logic before a build can start.'],
  ['Configuration build', 'The compiler builds the CHT configuration from the approved logic.'],
  ['Build verification', 'The verifier tests the compiled package against the expected results.'],
  ['Release approval', 'A separate approver reviews the verification evidence before release.'],
  ['Package available', 'The approved CHT package is ready to download.']
]

const stageByStatus = {
  queued: 5,
  WAITING_FOR_SCREENING: 6,
  WAITING_FOR_PO_CONFIRMATION: 6,
  READY_TO_ROUTE: 6,
  READY_FOR_LOGIC_PROPOSAL: 6,
  DRAFTING_LOGIC: 6,
  NEEDS_SD_REVIEW: 6,
  WAITING_FOR_LOGIC_CHECKS: 7,
  WAITING_FOR_CLINICAL_APPROVAL: 8,
  CLINICALLY_APPROVED: 9,
  COMPILING: 9,
  WAITING_FOR_VERIFICATION: 10,
  VERIFYING: 10,
  WAITING_FOR_RELEASE_APPROVAL: 11,
  RELEASE_APPROVED: 12,
  DOWNLOAD_READY: 12
}

const attentionStatuses = new Set(['blocked', 'FAILED', 'REJECTED', 'RETURNED_FOR_CLARIFICATION', 'NEEDS_SD_REVIEW', 'superseded'])

export function trackingState(revision, state = {}) {
  const blocked = revision.screeningStatus === 'blocked'
  const status = blocked ? 'blocked' : state.status || 'pending_screening'
  const workflow = state.workflow
  const downstreamStage = blocked ? undefined : stageByStatus[workflow?.stoppedAt ?? workflow?.status]
  const handedOff = downstreamStage !== undefined
  const screeningPassed = handedOff || status === 'screening_passed'
  const preview = handedOff || (screeningPassed && Boolean(state.preview))
  const confirmed = handedOff || (preview && Boolean(state.confirmed))
  const intakeStage = state.rejection ? 3 : blocked ? 1 : !screeningPassed ? 2 : !preview ? 3 : !confirmed ? 4 : 5
  const current = downstreamStage ?? intakeStage
  const workflowAttention = attentionStatuses.has(workflow?.status)
  const completed = downstreamStage === stageByStatus.RELEASE_APPROVED && workflow?.downloadable === true && !workflowAttention
  const attention = workflowAttention || (!handedOff &&
    (Boolean(state.rejection) || ['blocked', 'needs_clarification', 'screening_blocked', 'screening_failed'].includes(status)))
  const labels = ['Request received', 'Intake checks', 'Completeness screening', 'Preview', 'Your confirmation', 'Downstream handoff']
  const descriptions = [
    'Your submission is saved with its own revision record.',
    blocked ? 'Update the required details before this request can move on.' : 'Required details and the configuration baseline have been validated.',
    handedOff ? 'Completeness screening passed for this revision.'
      : status === 'needs_clarification' ? 'More information is needed. Submit a corrected revision.'
      : status === 'screening_blocked' ? 'Screening stopped. Review the issues below.'
      : status === 'screening_failed' ? 'Screening could not finish. Review the available actions below.'
      : status === 'screening' ? 'Your requirements are being checked for completeness.'
      : screeningPassed ? 'Completeness screening passed for this revision.'
      : state.enabled === false ? 'Waiting for screening to be enabled.' : 'Waiting for a completeness check.',
    handedOff ? 'The preview captured the confirmed request.' : state.rejection ? 'Preview rejected. Use Edit to submit a correction.' : preview ? 'A summary of this exact revision is ready to review.' : 'A request summary can be created after screening passes.',
    confirmed ? 'You confirmed the preview for this revision.' : 'Review the preview and confirm when it reflects your request.',
    confirmed ? 'Queued for downstream drafting. The workflow has not started.' : 'Handoff waits for screening, preview, and confirmation.'
  ]
  if (workflow) {
    if (current > 5) {
      descriptions[4] = 'You confirmed the preview for this revision.'
      descriptions[5] = 'The confirmed revision was accepted for downstream work.'
    }
    for (const [label, description] of downstream) {
      labels.push(label)
      descriptions.push(description)
    }
    if (workflow.message) descriptions[current] = workflow.message
    else if (workflowAttention || current === 5) descriptions[current] = workflow.label || descriptions[current]
    if (!completed) descriptions[stageByStatus.RELEASE_APPROVED] = 'The package becomes available after release approval.'
  }
  const headline = workflowAttention ? workflow.label || 'Your request needs attention'
    : attention ? 'Your request needs attention'
    : downstreamStage !== undefined ? workflow.label || labels[current]
    : confirmed ? 'Queued for handoff' : labels[current]
  return { current, attention, completed, headline,
    steps: labels.map((label, index) => ({ label, description: descriptions[index],
      state: index < current || (index === current && completed) ? 'complete'
        : index === current ? attention ? 'attention' : 'current' : 'upcoming' })) }
}
