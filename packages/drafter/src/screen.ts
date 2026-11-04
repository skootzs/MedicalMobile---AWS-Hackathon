// Deterministic input screening, run before any model call.
// In live mode Bedrock Guardrails also screens the same text (see bedrock.ts).
import type { GuidelineSource } from './extract.ts';

export interface Screening {
  status: 'ok' | 'unusable' | 'rejected';
  reasons: string[];
}

const PII_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { label: 'phone number', re: /(?:\+?\d[\d\s().-]{8,}\d)/ },
  { label: 'patient name', re: /\b(patient|child|mother|caregiver)(?:'s)?\s+name\s*(?:is|:)\s*[A-Z][a-z]+/i },
  { label: 'date of birth', re: /\b(dob|date of birth|born on)\b\s*:?\s*\d/i },
];

export function screenInputs(source: GuidelineSource, request: string): Screening {
  const reasons: string[] = [];
  if (source.pages.size === 0) reasons.push('Guideline has no "## Page N" sections');
  for (const [n, text] of source.pages) {
    if (text.length < 40 || /<paste/i.test(text)) reasons.push(`Page ${n} has no usable text (placeholder or empty)`);
  }
  if (reasons.length) return { status: 'unusable', reasons };

  if (!request.trim()) return { status: 'rejected', reasons: ['The officer request is empty'] };
  for (const { label, re } of PII_PATTERNS) {
    if (re.test(request)) reasons.push(`The request appears to contain personal data (${label}). Use synthetic or general wording only.`);
  }
  return reasons.length ? { status: 'rejected', reasons } : { status: 'ok', reasons: [] };
}
