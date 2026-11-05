export const reviewCategories = profile => [
  ['clinician', 'CLINICAL', 'Clinical review'],
  ['release approver', 'RELEASE', 'Release review'],
  ['service designer', 'SERVICE_DESIGNER', 'Design clarification']
].filter(([role]) => profile.roles.includes(role))

export async function openReviewInbox({ api, profile, append, dialog, body }) {
  if (!dialog.open) dialog.showModal()
  const categories = reviewCategories(profile)
  body.replaceChildren()
  const tabs = append(body, 'div', '')
  const panel = append(body, 'section', '')
  const reportError = error => append(panel, 'p', error.message)
  for (const [, category, label] of categories) {
    const button = append(tabs, 'button', label)
    button.type = 'button'
    button.onclick = () => queue(category).catch(reportError)
  }
  if (categories.length) await queue(categories[0][1])

  async function queue(category) {
    panel.replaceChildren()
    const { items } = await api(`/api/workflow/reviews/queue?category=${category}`)
    if (!items.length) append(panel, 'p', 'No requests are waiting for this review.')
    for (const item of items) {
      const button = append(panel, 'button', `Review request ${item.requestId.slice(0, 16)}`)
      button.type = 'button'
      button.onclick = () => context(item, category).catch(reportError)
    }
  }

  async function context(item, category) {
    const base = `/api/workflow/requests/${item.requestId}`
    const review = await api(`${base}/review-context?category=${category}&expectedVersion=${item.workflowVersion}`)
    panel.replaceChildren()
    append(panel, 'button', 'Back to review queue').onclick = () => queue(category).catch(reportError)
    append(panel, 'h3', review.preview?.content?.title ?? item.requestId)
    for (const [label, data] of [
      ['Confirmed request', review.preview?.content], ['Proposed clinical logic', review.logicModel?.content],
      ['Checker findings', review.checkerReport?.findings], ['Compiled artifact', review.artifact],
      ['Verification result', review.verification], ['Clarification', review.clarification]
    ]) {
      if (data == null) continue
      append(panel, 'h4', label)
      append(panel, 'pre', JSON.stringify(data, null, 2))
    }
    if (review.verification) {
      const button = append(panel, 'button', 'View verification evidence')
      button.type = 'button'
      button.onclick = async () => {
        try {
          const evidence = await api(`${base}/verification-report?expectedVersion=${item.workflowVersion}`)
          append(panel, 'pre', JSON.stringify(evidence, null, 2))
          button.disabled = true
        } catch (error) { reportError(error) }
      }
    }
    if (!review.eligibility.eligible || !review.decisionReferences) {
      for (const reason of review.eligibility.reasons) append(panel, 'p', reason)
      return
    }
    const label = append(panel, 'label', 'Decision notes')
    const note = append(label, 'textarea', '')
    note.maxLength = 2000
    const controls = append(panel, 'div', '')
    const status = append(panel, 'p', '')
    status.setAttribute('aria-live', 'polite')
    let pending
    for (const [decision, text] of [['APPROVE', 'Approve'], ['RETURN', 'Return for clarification'], ['REJECT', 'Reject']]) {
      const button = append(controls, 'button', text)
      button.type = 'button'
      button.onclick = async () => {
        const value = note.value.trim()
        if (!value && decision !== 'APPROVE') { status.textContent = 'Enter a reason for this decision.'; return }
        if (pending?.decision !== decision || pending.note !== value) pending = { decision, note: value, eventId: crypto.randomUUID() }
        for (const control of controls.children) control.disabled = true
        try {
          const route = category === 'CLINICAL' ? 'clinical-decisions' : 'release-decisions'
          await api(`${base}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...review.decisionReferences, decision, eventId: pending.eventId, ...(value ? { note: value } : {}) }) })
          await queue(category)
          append(panel, 'p', 'Decision recorded.')
        } catch (error) {
          status.textContent = error.status === 409 ? 'This review changed. Go back to refresh the queue.' : error.message
          for (const control of controls.children) control.disabled = false
        }
      }
    }
  }
}
