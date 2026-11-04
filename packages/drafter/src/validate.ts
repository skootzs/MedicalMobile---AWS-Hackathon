// Format check for model output. Model output is never trusted.
// Uses Role 5's compiler as the authority on the LogicModel v1 shape, as agreed with Matiyas:
// "If the compiler accepts it, the format is right." An open blocking ambiguity is allowed here:
// it is a correct draft that a clinician must resolve, not a format error.
// When Role 4 publishes packages/schema, switch this file to that schema.

export interface FormatError {
  code: string;
  path: string;
  message: string;
}

export interface FormatCheck {
  ok: boolean;
  checker: 'compiler' | 'basic';
  errors: FormatError[];
  /** Compiler errors that only mean "needs a clinician" (open blocking ambiguities). */
  blockingAmbiguities: FormatError[];
  /** Questions and rules without source.page and source.quote (team rule). */
  sourceErrors: FormatError[];
}

/** Team rule: every question and rule needs source.page and source.quote. */
export function checkSources(input: unknown): FormatError[] {
  if (typeof input !== 'object' || input === null) return [];
  const m = input as Record<string, unknown>;
  const errors: FormatError[] = [];
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const need = (el: Record<string, unknown> | undefined, path: string, what: string) => {
    if (!el) return;
    const src = el.source as Record<string, unknown> | undefined;
    if (!src || typeof src.page !== 'number' || typeof src.quote !== 'string' || !src.quote.trim()) {
      errors.push({ code: 'MISSING_SOURCE', path: `${path}.source`, message: `${what} needs source.page and source.quote copied from the guideline` });
    }
  };
  need(m.applicability as Record<string, unknown> | undefined, '$.applicability', 'Applicability');
  arr(m.questions).forEach((q, i) => need(q, `$.questions[${i}]`, `Question '${String(q.id)}'`));
  arr(m.derived).forEach((d, i) => need(d, `$.derived[${i}]`, `Derived value '${String(d.id)}'`));
  arr(m.decisionTables).forEach((t, ti) =>
    arr(t.rows).forEach((r, ri) => need(r, `$.decisionTables[${ti}].rows[${ri}]`, `Decision row ${ri + 1} (${String(r.outcome)})`)));
  return errors;
}

type CompileFn = (input: unknown) => { ok: true } | { ok: false; errors: FormatError[] };

let compilePromise: Promise<CompileFn | null> | null = null;

async function loadCompiler(): Promise<CompileFn | null> {
  compilePromise ??= import('../../compiler/src/index.ts')
    .then((m: Record<string, unknown>) => (typeof m.compileLogicModel === 'function' ? (m.compileLogicModel as CompileFn) : null))
    .catch(() => null);
  return compilePromise;
}

const REQUIRED = ['schemaVersion', 'pathwayId', 'title', 'language', 'sources', 'context', 'questions', 'derived', 'decisionTables', 'outcomes', 'ambiguities'];

function basicCheck(input: unknown): FormatError[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return [{ code: 'INVALID_INPUT', path: '$', message: 'Model output is not a JSON object' }];
  }
  const obj = input as Record<string, unknown>;
  const errors: FormatError[] = [];
  for (const key of REQUIRED) if (!(key in obj)) errors.push({ code: 'MISSING_FIELD', path: `$.${key}`, message: `Missing ${key}` });
  if (obj.schemaVersion !== undefined && obj.schemaVersion !== '1.0') {
    errors.push({ code: 'UNSUPPORTED_SCHEMA_VERSION', path: '$.schemaVersion', message: 'schemaVersion must be "1.0"' });
  }
  return errors;
}

export async function checkFormat(input: unknown): Promise<FormatCheck> {
  const basic = basicCheck(input);
  if (basic.length) return { ok: false, checker: 'basic', errors: basic, blockingAmbiguities: [], sourceErrors: [] };
  const sourceErrors = checkSources(input);

  const compile = await loadCompiler();
  if (!compile) return { ok: true, checker: 'basic', errors: [], blockingAmbiguities: [], sourceErrors };

  const result = compile(input);
  if (result.ok) return { ok: true, checker: 'compiler', errors: [], blockingAmbiguities: [], sourceErrors };
  const blockingAmbiguities = result.errors.filter((e) => e.code === 'OPEN_BLOCKING_AMBIGUITY');
  const errors = result.errors.filter((e) => e.code !== 'OPEN_BLOCKING_AMBIGUITY');
  return { ok: errors.length === 0, checker: 'compiler', errors, blockingAmbiguities, sourceErrors };
}
