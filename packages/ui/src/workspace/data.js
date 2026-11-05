export const specialties = ['Infectious diseases', 'Cardiovascular', 'Primary care', 'Maternal & child health', 'Respiratory', 'Emergency care']
export const collections = [
  { id: 'infectious-diseases', name: 'Infectious diseases', icon: 'bug', description: 'Condition and presenting-symptom references spanning tropical medicine, respiratory care, primary care and maternal health.' },
  { id: 'primary-care', name: 'Primary care', icon: 'stethoscope', description: 'References for assessment, ongoing review and continuity of care in the community.' },
  { id: 'maternal-child-health', name: 'Maternal & child health', icon: 'baby', description: 'Illustrative references for maternal health, antenatal care and children.' },
  { id: 'cardiovascular', name: 'Cardiovascular', icon: 'heart', description: 'Condition references for cardiovascular assessment and ongoing review.' },
  { id: 'respiratory', name: 'Respiratory', icon: 'wind', description: 'References for respiratory presentations and assessment.' },
  { id: 'emergency-care', name: 'Emergency care', icon: 'siren', description: 'Source navigation for urgent assessment and local escalation pathways.' }
]
const entries = [
  ['malaria', 'Malaria', 'Infectious diseases', 'Tropical medicine', 'Suspected or confirmed malaria · Assessment to follow-up', ['infectious-diseases'], ['fever', 'travel']],
  ['hypertension', 'Hypertension', 'Cardiovascular', 'Cardiovascular', 'Adult hypertension · Assessment and ongoing review', ['cardiovascular', 'primary-care'], ['blood pressure']],
  ['pneumonia', 'Pneumonia', 'Respiratory', 'Respiratory', 'Community-acquired pneumonia · Condition reference', ['respiratory', 'primary-care'], ['cough']],
  ['antenatal-care', 'Antenatal care', 'Maternal & child health', 'Maternal health', 'Routine antenatal care · Reference overview', ['maternal-child-health'], ['pregnancy']],
  ['type-2-diabetes', 'Type 2 diabetes', 'Primary care', 'Primary care', 'Adult diabetes · Assessment and follow-up reference', ['primary-care'], ['glucose']],
  ['tuberculosis', 'Tuberculosis', 'Infectious diseases', 'Respiratory', 'Suspected tuberculosis · Condition reference', ['infectious-diseases', 'respiratory'], ['cough', 'TB']],
  ['hiv', 'HIV', 'Infectious diseases', 'Primary care', 'HIV care · Reference overview and source navigation', ['infectious-diseases', 'primary-care'], []],
  ['covid-19', 'COVID-19', 'Respiratory', 'Respiratory', 'Condition overview · Assessment and follow-up reference', ['infectious-diseases', 'respiratory'], ['coronavirus', 'fever', 'initial assessment', 'triage']],
  ['malaria-in-pregnancy', 'Malaria in pregnancy', 'Maternal & child health', 'Maternal health', 'Pregnancy-specific reference · Related to Malaria', ['infectious-diseases', 'maternal-child-health'], ['fever']],
  ['fever-following-travel', 'Fever following travel', 'Infectious diseases', 'Tropical medicine', 'Presenting symptom reference · Travel and exposure context', ['infectious-diseases', 'emergency-care'], ['fever']]
]
export const guidelines = entries.map(([id, title, specialty, subspecialty, summary, collections, keywords]) => ({ id, title, specialty, subspecialty, summary, collections, keywords, status: 'Local review pending', sourceLabel: id.includes('malaria') ? 'WHO Guidelines for malaria' : ['antenatal-care','tuberculosis','hiv'].includes(id) ? 'WHO reference to consult' : 'Official national guidance to confirm', sourceUrl: id.includes('malaria') ? 'https://www.who.int/teams/global-malaria-programme/guidelines-for-malaria' : 'https://www.who.int/publications', related: id === 'malaria' ? ['malaria-in-pregnancy', 'fever-following-travel'] : ['malaria', 'covid-19'].filter(other => other !== id) }))
export const careSteps = [
  ['Assess presentation & urgency', 'Review clinical presentation, vital signs, exposure and travel history. Consider other causes and assess for severe illness.', 'First priority', 'Concern for severe illness? Use the urgent-escalation area.'],
  ['Review diagnostic testing', 'Consult local guidance for appropriate testing and interpretation. Review results alongside the clinical assessment.', 'Diagnostic review', 'Testing unavailable or uncertainty persists? Seek local clinical advice.'],
  ['Establish severity & care setting', 'Consider clinical findings, test results and individual risk factors. Use local criteria to guide senior review and the appropriate care setting.', 'Care planning', 'Check pregnancy status, age group and relevant comorbidities.'],
  ['Consult the local management protocol', 'Review the locally approved pathway for the clinical context and test findings. Confirm medicine choice, contraindications and monitoring with an authorized clinician.', 'Local protocol required', 'This concept does not provide medicine selection or dosing.'],
  ['Plan reassessment & follow-up', 'Document the assessment and plan. Review local recommendations for reassessment, follow-up testing and clear return precautions.', 'Continuity of care', 'Make escalation and follow-up arrangements explicit.']
]
