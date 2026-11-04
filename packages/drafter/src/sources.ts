// Source traceability checks. Deterministic: no model involved.
//  1. Every citation's quote must appear on the cited page (whitespace ignored, wording exact).
//  2. Every number in a clinical condition must appear on that element's cited page
//     (or be a years-to-months conversion of a number that does, e.g. 5 years -> 60).
//  3. Every question and rule without source.page and source.quote is flagged.
// Failures become blocking ambiguities in the LogicModel, so the compiler will not build until a clinician decides.
import { normalize, type GuidelineSource } from './extract.ts';

interface SourceRef {
  sourceId?: string;
  page?: number;
  quote?: string;
}

export interface CitationResult {
  path: string;
  elementId: string;
  page?: number;
  quote?: string;
  verified: boolean;
  problem?: 'missing_citation' | 'quote_not_found' | 'page_not_found';
}

export interface NumberResult {
  path: string;
  elementId: string;
  value: number;
  page?: number;
  found: boolean;
}

export interface NewAmbiguity {
  id: string;
  text: string;
  status: 'open';
  blocking: boolean;
  sourceRef?: { sourceId: string; page?: number };
}

interface Element {
  path: string;
  id: string;
  clinical: boolean; // derived values, decision rows, applicability make clinical claims
  source?: SourceRef;
  conditions: unknown[];
}

function elements(model: Record<string, unknown>): Element[] {
  const list: Element[] = [];
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const app = model.applicability as Record<string, unknown> | undefined;
  if (app) list.push({ path: '$.applicability', id: 'applicability', clinical: true, source: app.source as SourceRef, conditions: [app.when] });
  arr(model.questions).forEach((q, i) =>
    list.push({ path: `$.questions[${i}]`, id: String(q.id), clinical: false, source: q.source as SourceRef, conditions: [q.relevantWhen] }));
  arr(model.derived).forEach((d, i) =>
    list.push({ path: `$.derived[${i}]`, id: String(d.id), clinical: true, source: d.source as SourceRef, conditions: [d.when] }));
  arr(model.decisionTables).forEach((t, ti) =>
    arr(t.rows).forEach((r, ri) =>
      list.push({ path: `$.decisionTables[${ti}].rows[${ri}]`, id: `${String(t.id)} row ${ri + 1} -> ${String(r.outcome)}`, clinical: true, source: r.source as SourceRef, conditions: [r.when] })));
  return list;
}

function numbersIn(condition: unknown, out: number[] = []): number[] {
  if (Array.isArray(condition)) {
    for (const c of condition) numbersIn(c, out);
  } else if (condition && typeof condition === 'object') {
    for (const [op, arg] of Object.entries(condition)) {
      if (['lt', 'lte', 'gt', 'gte', 'eq', 'neq'].includes(op) && Array.isArray(arg) && typeof arg[1] === 'number') out.push(arg[1]);
      else numbersIn(arg, out);
    }
  }
  return out;
}

function numberOnPage(value: number, pageText: string): boolean {
  const has = (n: number, after = '') => new RegExp(`(^|[^\\d.])${String(n).replace('.', '\\.')}(?![\\d.]\\d)${after}`, 'i').test(pageText);
  if (has(value)) return true;
  return value % 12 === 0 && value > 0 && has(value / 12, '\\s*years?');
}

export function verifySources(model: Record<string, unknown>, source: GuidelineSource) {
  const citations: CitationResult[] = [];
  const numbers: NumberResult[] = [];
  const pageNorm = new Map([...source.pages].map(([n, t]) => [n, normalize(t)]));

  for (const el of elements(model)) {
    const ref = el.source;
    if (!ref || typeof ref.page !== 'number' || typeof ref.quote !== 'string' || !ref.quote.trim()) {
      citations.push({ path: el.path, elementId: el.id, page: ref?.page, verified: false, problem: 'missing_citation' });
      continue;
    }
    const page = ref.page !== undefined ? pageNorm.get(ref.page) : undefined;
    if (page === undefined) {
      citations.push({ path: el.path, elementId: el.id, page: ref.page, quote: ref.quote, verified: false, problem: 'page_not_found' });
    } else if (!page.includes(normalize(ref.quote))) {
      citations.push({ path: el.path, elementId: el.id, page: ref.page, quote: ref.quote, verified: false, problem: 'quote_not_found' });
    } else {
      citations.push({ path: el.path, elementId: el.id, page: ref.page, quote: ref.quote, verified: true });
    }
    if (el.clinical && page !== undefined) {
      for (const value of numbersIn(el.conditions)) {
        numbers.push({ path: el.path, elementId: el.id, value, page: ref.page, found: numberOnPage(value, page) });
      }
    }
  }
  return { citations, numbers };
}

/** Turns failed checks into blocking ambiguities: a clinician must decide each one before the compiler will build. */
export function ambiguitiesFor(
  report: ReturnType<typeof verifySources>,
  sourceId: string,
  existingIds: Set<string>,
): NewAmbiguity[] {
  const out: NewAmbiguity[] = [];
  let n = 1;
  const nextId = () => {
    while (existingIds.has(`R3_${n}`)) n++;
    const id = `R3_${n}`;
    existingIds.add(id);
    return id;
  };
  for (const c of report.citations) {
    if (c.verified) continue;
    const ref = { sourceId, page: c.page };
    if (c.problem === 'quote_not_found') {
      out.push({ id: nextId(), status: 'open', blocking: true, sourceRef: ref,
        text: `Unsupported claim: the quote cited for ${c.elementId} ("${c.quote}") is not on page ${c.page} of the guideline.` });
    } else if (c.problem === 'page_not_found') {
      out.push({ id: nextId(), status: 'open', blocking: true, sourceRef: { sourceId },
        text: `Unsupported claim: ${c.elementId} cites page ${c.page}, which is not in the supplied guideline text.` });
    } else {
      out.push({ id: nextId(), status: 'open', blocking: true, sourceRef: { sourceId },
        text: `No citation: ${c.elementId} has no source.page and source.quote. A clinician must supply the source or confirm the rule.` });
    }
  }
  for (const num of report.numbers) {
    if (num.found) continue;
    out.push({ id: nextId(), status: 'open', blocking: true, sourceRef: { sourceId, page: num.page },
      text: `Missing threshold: ${num.elementId} uses the value ${num.value}, which does not appear on cited page ${num.page}. A clinician must supply or confirm it.` });
  }
  return out;
}
