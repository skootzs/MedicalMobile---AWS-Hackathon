import { guidelines } from './data.js'
export const dayAt = (offset, hours = 12, minutes = 0, now = new Date()) => { const d = new Date(now); d.setDate(d.getDate() - offset); d.setHours(hours,minutes,0,0); return d.toISOString() }
export function seedState(now = new Date()) {
  return { version: 1, saved: ['malaria','hypertension','pneumonia','antenatal-care','type-2-diabetes','tuberculosis'].map((id,i) => ({id,at:dayAt([0,1,2,5,7,9][i],12,0,now)})), history: [
    ['guideline','malaria',0,10,42], ['guideline','hypertension',0,9,18], ['guideline','pneumonia',1,16,25], ['guideline','fever-following-travel',1,14,6], ['guideline','antenatal-care',2,15,40], ['guideline','type-2-diabetes',2,10,12]
  ].map(([type,id,day,hour,minute]) => ({type,id,at:dayAt(day,hour,minute,now)})) }
}
export function filterGuidelines(items, { query = '', specialty = '', status = '' } = {}) {
  const words = query.toLowerCase().match(/[\p{L}\p{N}-]+/gu) || []
  const meaningful = words.filter(w => !['what','is','the','best','for','a','an','and','of','in','with','to','about','suspected','condition','assessment','pathway'].includes(w))
  return items.filter(g => (!specialty || g.specialty === specialty) && (!status || g.status === status) && (!meaningful.length || meaningful.some(w => `${g.title} ${g.summary} ${g.specialty} ${g.keywords.join(' ')}`.toLowerCase().includes(w))))
}
export function visit(history, type, id, at = new Date().toISOString()) {
  return [{type,id,at}, ...history.filter(x => !(x.type === type && x.id === id))].slice(0,200)
}
export function toggleSaved(saved, id, at = new Date().toISOString()) {
  return saved.some(x => x.id === id) ? saved.filter(x => x.id !== id) : [{id,at},...saved]
}
export function createLocalState(authorId, storage) {
  const key = `cht:workspace:v1:${authorId}`
  let state
  let warning = ''
  try { storage ??= globalThis.localStorage; const raw = storage.getItem(key); state = raw ? JSON.parse(raw) : seedState(); if (state.version !== 1 || !Array.isArray(state.saved) || !Array.isArray(state.history)) throw new Error('Invalid saved data'); state.saved = state.saved.filter(x => guidelines.some(g => g.id === x.id) && typeof x.at === 'string'); state.history = state.history.filter(x => ['guideline','protocol'].includes(x.type) && typeof x.id === 'string' && !Number.isNaN(Date.parse(x.at))) } catch { state = seedState(); warning = 'Browser storage is unavailable or could not be read. Changes will last for this session only.' }
  const persist = () => { try { storage.setItem(key, JSON.stringify(state)) } catch { warning = 'Browser storage is full or unavailable. Changes will last for this session only.' } }
  persist()
  return { get value(){ return state }, get warning(){ return warning }, save(id){state.saved = toggleSaved(state.saved,id); persist()}, open(type,id){state.history = visit(state.history,type,id); persist()}, remove(type,id){ state.history = state.history.filter(x => x.type !== type || x.id !== id); persist() }, clear(){state.history=[];persist()} }
}
