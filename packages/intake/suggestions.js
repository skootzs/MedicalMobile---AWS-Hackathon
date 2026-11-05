import { fields, HttpError } from './intake.js'

// Coordinates always refer to the immutable normalized submission, never a model rewrite.
export function validateSuggestions(suggestions, requirements) {
  if (!Array.isArray(suggestions) || suggestions.length > 12) throw new Error('INVALID_MODEL_SUGGESTIONS')
  const ids = new Set(), ranges = new Map()
  for (const item of suggestions) {
    const keys = ['id', 'field', 'startLine', 'endLine', 'original', 'replacement', 'kind', 'rationale']
    if (!item || Object.keys(item).length !== keys.length || !keys.every(key => Object.hasOwn(item, key)) ||
        typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id) ||
        !fields.includes(item.field) || !['clarification', 'assumption'].includes(item.kind) ||
        !Number.isInteger(item.startLine) || !Number.isInteger(item.endLine) || item.startLine < 1 || item.endLine < item.startLine ||
        typeof item.original !== 'string' || item.original.length > 4000 ||
        typeof item.replacement !== 'string' || !item.replacement.trim() || item.replacement.length > 4000 || item.original === item.replacement ||
        typeof item.rationale !== 'string' || !item.rationale.trim() || item.rationale.length > 1000) throw new Error('INVALID_MODEL_SUGGESTIONS')
    if (requirements) {
      const lines = requirements[item.field].split('\n')
      if (item.endLine > lines.length || lines.slice(item.startLine - 1, item.endLine).join('\n') !== item.original) throw new Error('STALE_MODEL_SUGGESTION')
    }
    if ((ranges.get(item.field) || []).some(other => item.startLine <= other.endLine && item.endLine >= other.startLine)) throw new Error('OVERLAPPING_MODEL_SUGGESTIONS')
    ranges.set(item.field, [...(ranges.get(item.field) || []), item])
    ids.add(item.id)
  }
  return suggestions
}

export function applySuggestions(requirements, suggestions, selections) {
  validateSuggestions(suggestions, requirements)
  if (!Array.isArray(selections) || !selections.length || selections.length > 12) throw new HttpError(400, 'Select at least one suggested change.')
  const ids = new Set(), edits = []
  for (const selection of selections) {
    const suggestion = suggestions.find(item => item.id === selection?.id)
    if (!suggestion || ids.has(selection.id) || Object.keys(selection).some(key => !['id', 'replacement', 'acceptAssumption'].includes(key)) ||
        typeof selection.replacement !== 'string' || !selection.replacement.trim() || selection.replacement.length > 4000 ||
        (suggestion.kind === 'assumption' && selection.acceptAssumption !== true)) throw new HttpError(400, 'Review each change and explicitly accept any assumptions.')
    ids.add(selection.id)
    edits.push({ ...suggestion, replacement: selection.replacement })
  }
  const result = { ...requirements }
  for (const field of fields) {
    const lines = result[field].split('\n')
    for (const edit of edits.filter(item => item.field === field).sort((a, b) => b.startLine - a.startLine)) {
      lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, edit.replacement)
    }
    result[field] = lines.join('\n')
    if (!result[field].trim() || result[field].length > 4000) throw new HttpError(400, 'The revised field must contain 1 to 4,000 characters.')
  }
  if (fields.every(field => result[field] === requirements[field])) throw new HttpError(400, 'The selected changes do not change the request.')
  return result
}
