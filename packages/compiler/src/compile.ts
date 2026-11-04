import { ErrorList, type CompileError } from './errors.ts';
import { buildFormProperties, type FormProperties } from './form-properties.ts';
import { canonicalJson, sha256 } from './hash.ts';
import { xlsFormToXlsx, type XlsForm, type XlsFormRow } from './xlsform-adapter.ts';
import {
  compileCondition,
  numberLiteral,
  ref,
  triStateCalculation,
  type SymbolInfo,
  type TriState,
} from './xpath.ts';

export const COMPILER_NAME = '@cht-nocode/compiler';
export const COMPILER_VERSION = '0.1.0';
export const SUPPORTED_SCHEMA_VERSION = '1.0';

export interface CompileOptions {
  /** Hash of the approved snapshot, as recorded by the approval service (Role 2). Copied into the manifest. */
  snapshotHash?: string;
  /** Text shown in red on the first page and the summary, e.g. "DEMONSTRATION ONLY". */
  watermark?: string;
  /** Icon key; must exist in the target project's resources.json. */
  icon?: string;
}

export interface GeneratedFile {
  path: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface CompileManifest {
  manifestVersion: 1;
  compiler: { name: string; version: string };
  logicModelSchemaVersion: string;
  pathwayId: string;
  formId: string;
  title: string;
  snapshotHash: string | null;
  inputHash: string;
  artifactHash: string;
  options: { watermark: string | null; icon: string };
  files: { path: string; sha256: string; bytes: number }[];
  outputFields: {
    classification: string;
    referralUrgent: string;
    followUpDays: string;
    followUpDate: string;
    inScope: string | null;
  };
  decisionTable: { id: string; hitPolicy: 'unique' | 'first'; rows: number; otherwise: string };
  outcomes: { id: string; referral: 'urgent' | 'none'; followUpDays: number | null }[];
  openAmbiguities: { id: string; text: string }[];
}

export interface CompiledArtifact {
  formId: string;
  xlsForm: XlsForm;
  properties: FormProperties;
  files: GeneratedFile[];
  manifest: CompileManifest;
}

export type CompileResult = { ok: true; artifact: CompiledArtifact } | { ok: false; errors: CompileError[] };

const ID = /^[a-z][a-z0-9_]{0,62}$/;
const ICON = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SNAPSHOT_HASH = /^[A-Za-z0-9:_-]{8,128}$/;
const RESERVED = new Set([
  'inputs', 'source', 'source_id', 'contact', 'name', 'patient_id', 'patient_uuid', 'patient_name',
  'date_of_birth', 'parent', 'in_scope', 'referral_urgent', 'follow_up_days', 't_follow_up_date',
  'watermark_note', 'summary', 'summary_watermark_note', 'meta', 'data', 'instanceid', 'instanceID',
  'deprecatedid', 'yes_no', 'start', 'end', 'today',
]);
const QUESTION_TYPES = new Set(['boolean', 'integer', 'decimal', 'select_one']);
const LANGUAGE = 'en';
const DEFAULT_ICON = 'icon-healthcare';
const SURVEY_COLUMNS = [
  'type', 'name', `label::${LANGUAGE}`, `hint::${LANGUAGE}`, 'required', 'relevant', 'appearance',
  'constraint', `constraint_message::${LANGUAGE}`, 'calculation', 'default',
];

interface ValidQuestion {
  id: string;
  type: 'boolean' | 'integer' | 'decimal' | 'select_one';
  label: string;
  hint?: string;
  page: string;
  options: { id: string; label: string }[];
  min?: string;
  max?: string;
  relevance: TriState | null;
}

interface ValidOutcome {
  id: string;
  label: string;
  referral: 'urgent' | 'none';
  followUpDays: number | null;
  message?: string;
}

type Obj = Record<string, unknown>;

class Validator {
  readonly errors = new ErrorList();
  private readonly names = new Map<string, string>();

  object(value: unknown, path: string, required: string[], optional: string[] = []): Obj | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.errors.add('INVALID_VALUE', path, 'Expected an object');
      return null;
    }
    const obj = value as Obj;
    for (const key of Object.keys(obj)) {
      if (!required.includes(key) && !optional.includes(key)) {
        this.errors.add('UNKNOWN_FIELD', `${path}.${key}`, `Field '${key}' is not part of LogicModel v${SUPPORTED_SCHEMA_VERSION}`);
      }
    }
    for (const key of required) {
      if (obj[key] === undefined) this.errors.add('MISSING_FIELD', `${path}.${key}`, `Required field '${key}' is missing`);
    }
    return obj;
  }

  array(value: unknown, path: string, nonEmpty = false): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.errors.add('INVALID_VALUE', path, 'Expected an array');
      return [];
    }
    if (nonEmpty && value.length === 0) this.errors.add('INVALID_VALUE', path, 'Must not be empty');
    return value;
  }

  id(value: unknown, path: string): string | null {
    if (typeof value !== 'string' || !ID.test(value)) {
      if (value !== undefined) {
        this.errors.add('INVALID_ID', path, `${JSON.stringify(value)} is not a valid id (lowercase letter, then lowercase letters, digits or _; max 63)`);
      }
      return null;
    }
    return value;
  }

  // Display text: no XLSForm references, no HTML, no control characters other than newline.
  text(value: unknown, path: string): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.trim() === '') {
      this.errors.add('INVALID_VALUE', path, 'Expected non-empty text');
      return null;
    }
    if (value.includes('${') || /[<>]/.test(value) || /[\u0000-\u0009\u000B-\u001F]/.test(value)) {
      this.errors.add('UNSUPPORTED_TEXT', path, "Text must not contain '${', '<', '>' or control characters");
      return null;
    }
    return value;
  }

  plainString(value: unknown, path: string): void {
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      this.errors.add('INVALID_VALUE', path, 'Expected non-empty text');
    }
  }

  registerName(name: string, path: string): void {
    if (RESERVED.has(name) || RESERVED.has(name.toLowerCase())) {
      this.errors.add('RESERVED_ID', path, `'${name}' is reserved by CHT or by the compiler`);
      return;
    }
    const previous = this.names.get(name);
    if (previous !== undefined) {
      this.errors.add('DUPLICATE_ID', path, `'${name}' is already used at ${previous}; form field names must be unique`);
      return;
    }
    this.names.set(name, path);
  }

  sourceRef(value: unknown, path: string, sources: ReadonlySet<string>): void {
    if (value === undefined) return;
    const obj = this.object(value, path, ['sourceId'], ['page', 'section', 'quote']);
    if (!obj) return;
    if (typeof obj.sourceId === 'string' && !sources.has(obj.sourceId)) {
      this.errors.add('UNKNOWN_SOURCE', `${path}.sourceId`, `Source '${obj.sourceId}' is not listed in sources`);
    }
    if (obj.page !== undefined && !(Number.isInteger(obj.page) && (obj.page as number) > 0)) {
      this.errors.add('INVALID_VALUE', `${path}.page`, 'Expected a positive whole number');
    }
    this.plainString(obj.section, `${path}.section`);
    this.plainString(obj.quote, `${path}.quote`);
  }
}

export function compileLogicModel(input: unknown, options: CompileOptions = {}): CompileResult {
  const v = new Validator();
  const errors = v.errors;

  const root = v.object(
    input,
    '$',
    ['schemaVersion', 'pathwayId', 'title', 'language', 'sources', 'context', 'questions', 'derived', 'decisionTables', 'outcomes', 'ambiguities'],
    ['applicability', 'pages'],
  );
  if (!root) return { ok: false, errors: errors.items };

  if (root.schemaVersion !== undefined && root.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    errors.add('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion', `Only LogicModel ${SUPPORTED_SCHEMA_VERSION} is supported; got ${JSON.stringify(root.schemaVersion)}`);
  }
  const formId = v.id(root.pathwayId, '$.pathwayId');
  const title = v.text(root.title, '$.title');
  if (root.language !== undefined && root.language !== LANGUAGE) {
    errors.add('UNSUPPORTED_LANGUAGE', '$.language', `Only '${LANGUAGE}' is supported; got ${JSON.stringify(root.language)}`);
  }

  const watermark = options.watermark === undefined ? null : v.text(options.watermark, 'options.watermark');
  const icon = options.icon ?? DEFAULT_ICON;
  if (!ICON.test(icon)) errors.add('INVALID_VALUE', 'options.icon', `${JSON.stringify(icon)} is not a valid icon key`);
  if (options.snapshotHash !== undefined && !SNAPSHOT_HASH.test(options.snapshotHash)) {
    errors.add('INVALID_VALUE', 'options.snapshotHash', 'Expected 8-128 characters from A-Z, a-z, 0-9, :, _ or -');
  }

  // Sources
  const sourceIds = new Set<string>();
  v.array(root.sources, '$.sources').forEach((s, i) => {
    const p = `$.sources[${i}]`;
    const obj = v.object(s, p, ['id', 'title'], ['sha256', 'url']);
    if (!obj) return;
    const id = v.id(obj.id, `${p}.id`);
    if (id && sourceIds.has(id)) errors.add('DUPLICATE_ID', `${p}.id`, `Source '${id}' is listed twice`);
    if (id) sourceIds.add(id);
    v.plainString(obj.title, `${p}.title`);
    v.plainString(obj.sha256, `${p}.sha256`);
    v.plainString(obj.url, `${p}.url`);
  });

  // Context values
  const symbols = new Map<string, SymbolInfo>();
  const context: { id: string }[] = [];
  v.array(root.context, '$.context').forEach((c, i) => {
    const p = `$.context[${i}]`;
    const obj = v.object(c, p, ['id', 'type', 'from']);
    if (!obj) return;
    if (obj.type !== 'integer' || obj.from !== 'contact.age_in_months') {
      errors.add('UNSUPPORTED_CONTEXT', p, `Only { type: 'integer', from: 'contact.age_in_months' } is supported; got type ${JSON.stringify(obj.type)} from ${JSON.stringify(obj.from)}`);
      return;
    }
    const id = v.id(obj.id, `${p}.id`);
    if (!id) return;
    v.registerName(id, `${p}.id`);
    symbols.set(id, { kind: 'number' });
    context.push({ id });
  });
  const contextSymbols = new Map(symbols);

  // Outcomes
  const outcomes: ValidOutcome[] = [];
  const outcomeIds = new Set<string>();
  v.array(root.outcomes, '$.outcomes', true).forEach((o, i) => {
    const p = `$.outcomes[${i}]`;
    const obj = v.object(o, p, ['id', 'label', 'referral'], ['followUp', 'message']);
    if (!obj) return;
    const id = v.id(obj.id, `${p}.id`);
    const label = v.text(obj.label, `${p}.label`);
    const message = v.text(obj.message, `${p}.message`) ?? undefined;
    if (obj.referral !== undefined && obj.referral !== 'urgent' && obj.referral !== 'none') {
      errors.add('INVALID_VALUE', `${p}.referral`, "Expected 'urgent' or 'none'");
    }
    let followUpDays: number | null = null;
    if (obj.followUp !== undefined) {
      const fu = v.object(obj.followUp, `${p}.followUp`, ['afterDays']);
      if (fu && fu.afterDays !== undefined) {
        if (Number.isInteger(fu.afterDays) && (fu.afterDays as number) > 0) followUpDays = fu.afterDays as number;
        else errors.add('INVALID_VALUE', `${p}.followUp.afterDays`, 'Expected a positive whole number of days');
      }
    }
    if (!id) return;
    if (outcomeIds.has(id)) errors.add('DUPLICATE_ID', `${p}.id`, `Outcome '${id}' is defined twice`);
    outcomeIds.add(id);
    v.registerName(`outcome_${id}`, `${p}.id`);
    if (label && (obj.referral === 'urgent' || obj.referral === 'none')) {
      outcomes.push({ id, label, referral: obj.referral, followUpDays, message });
    }
  });
  const referenced = new Set<string>();
  const outcomeRef = (value: unknown, path: string): string | null => {
    const id = v.id(value, path);
    if (!id) return null;
    if (!outcomeIds.has(id)) {
      errors.add('UNKNOWN_OUTCOME', path, `Outcome '${id}' is not defined in outcomes`);
      return null;
    }
    referenced.add(id);
    return id;
  };

  // Applicability (may only depend on context values)
  let applicability: { when: TriState; notApplicable: string; unknown: string } | null = null;
  if (root.applicability !== undefined) {
    const p = '$.applicability';
    const obj = v.object(root.applicability, p, ['when', 'notApplicableOutcome', 'unknownOutcome'], ['source']);
    if (obj) {
      const when = obj.when === undefined ? null : compileCondition(obj.when, contextSymbols, `${p}.when`, errors);
      const notApplicable = outcomeRef(obj.notApplicableOutcome, `${p}.notApplicableOutcome`);
      const unknown = outcomeRef(obj.unknownOutcome, `${p}.unknownOutcome`);
      v.sourceRef(obj.source, `${p}.source`, sourceIds);
      if (when && notApplicable && unknown) applicability = { when, notApplicable, unknown };
    }
  }

  // Pages
  const pages: { id: string; label: string }[] = [];
  const explicitPages = root.pages !== undefined;
  if (explicitPages) {
    v.array(root.pages, '$.pages', true).forEach((pg, i) => {
      const p = `$.pages[${i}]`;
      const obj = v.object(pg, p, ['id', 'label']);
      if (!obj) return;
      const id = v.id(obj.id, `${p}.id`);
      const label = v.text(obj.label, `${p}.label`);
      if (id) v.registerName(id, `${p}.id`);
      if (id && label) pages.push({ id, label });
    });
  } else if (title) {
    v.registerName('main_page', '$.pages');
    pages.push({ id: 'main_page', label: title });
  }
  const pageIds = new Set(pages.map((pg) => pg.id));

  // Questions (relevance may use context values and earlier questions)
  const questions: ValidQuestion[] = [];
  v.array(root.questions, '$.questions', true).forEach((q, i) => {
    const p = `$.questions[${i}]`;
    const obj = v.object(q, p, ['id', 'type', 'label'], ['hint', 'page', 'options', 'min', 'max', 'relevantWhen', 'source']);
    if (!obj) return;
    const id = v.id(obj.id, `${p}.id`);
    const label = v.text(obj.label, `${p}.label`);
    const hint = v.text(obj.hint, `${p}.hint`) ?? undefined;
    const type = obj.type;
    if (type !== undefined && (typeof type !== 'string' || !QUESTION_TYPES.has(type))) {
      errors.add('UNSUPPORTED_QUESTION_TYPE', `${p}.type`, `Question type ${JSON.stringify(type)} is not supported; supported: ${[...QUESTION_TYPES].join(', ')}`);
    }
    const numeric = type === 'integer' || type === 'decimal';

    const options: { id: string; label: string }[] = [];
    if (type === 'select_one') {
      const seen = new Set<string>();
      const list = v.array(obj.options, `${p}.options`);
      if (list.length < 2) errors.add('INVALID_VALUE', `${p}.options`, 'select_one needs at least two options');
      list.forEach((o, j) => {
        const op = `${p}.options[${j}]`;
        const oo = v.object(o, op, ['id', 'label']);
        if (!oo) return;
        const oid = v.id(oo.id, `${op}.id`);
        const olabel = v.text(oo.label, `${op}.label`);
        if (oid && seen.has(oid)) errors.add('DUPLICATE_ID', `${op}.id`, `Option '${oid}' is listed twice`);
        if (oid) seen.add(oid);
        if (oid && olabel) options.push({ id: oid, label: olabel });
      });
    } else if (obj.options !== undefined) {
      errors.add('INVALID_VALUE', `${p}.options`, 'Only select_one questions have options');
    }

    const bound = (key: 'min' | 'max'): string | undefined => {
      if (obj[key] === undefined) return undefined;
      const literal = numberLiteral(obj[key]);
      if (!numeric) errors.add('INVALID_VALUE', `${p}.${key}`, `'${key}' only applies to integer and decimal questions`);
      else if (literal === null || (type === 'integer' && !Number.isInteger(obj[key]))) {
        errors.add('INVALID_VALUE', `${p}.${key}`, `Expected a ${type === 'integer' ? 'whole' : 'finite'} number`);
      } else return literal;
      return undefined;
    };
    const min = bound('min');
    const max = bound('max');
    if (min !== undefined && max !== undefined && Number(min) > Number(max)) {
      errors.add('INVALID_VALUE', `${p}.min`, 'min is greater than max');
    }

    let page: string | null = null;
    if (explicitPages) {
      if (obj.page === undefined) errors.add('MISSING_FIELD', `${p}.page`, 'Every question needs a page when pages are declared');
      else if (typeof obj.page !== 'string' || !pageIds.has(obj.page)) errors.add('UNKNOWN_PAGE', `${p}.page`, `Page ${JSON.stringify(obj.page)} is not declared`);
      else page = obj.page;
    } else if (obj.page !== undefined) {
      errors.add('INVALID_VALUE', `${p}.page`, 'Questions can only name a page when pages are declared');
    } else {
      page = 'main_page';
    }

    const relevance = obj.relevantWhen === undefined ? null : compileCondition(obj.relevantWhen, symbols, `${p}.relevantWhen`, errors);
    v.sourceRef(obj.source, `${p}.source`, sourceIds);

    if (!id) return;
    v.registerName(id, `${p}.id`);
    if (!label || !page || typeof type !== 'string' || !QUESTION_TYPES.has(type)) return;
    const kind: SymbolInfo['kind'] = type === 'boolean' ? 'boolean' : type === 'select_one' ? 'select_one' : 'number';
    symbols.set(id, { kind, options: type === 'select_one' ? new Set(options.map((o) => o.id)) : undefined });
    questions.push({ id, type: type as ValidQuestion['type'], label, hint, page, options, min, max, relevance });
  });
  for (const pg of pages) {
    if (!questions.some((q) => q.page === pg.id) && errors.empty) {
      errors.add('EMPTY_PAGE', '$.pages', `Page '${pg.id}' has no questions`);
    }
  }

  // Derived values (may use context, questions and earlier derived values)
  const derived: { id: string; when: TriState }[] = [];
  v.array(root.derived, '$.derived').forEach((d, i) => {
    const p = `$.derived[${i}]`;
    const obj = v.object(d, p, ['id', 'type', 'when'], ['source']);
    if (!obj) return;
    if (obj.type !== undefined && obj.type !== 'boolean') {
      errors.add('UNSUPPORTED_NODE', `${p}.type`, `Only boolean derived values are supported; got ${JSON.stringify(obj.type)}`);
    }
    const id = v.id(obj.id, `${p}.id`);
    const when = obj.when === undefined ? null : compileCondition(obj.when, symbols, `${p}.when`, errors);
    v.sourceRef(obj.source, `${p}.source`, sourceIds);
    if (!id) return;
    v.registerName(id, `${p}.id`);
    symbols.set(id, { kind: 'derived' });
    if (when && obj.type === 'boolean') derived.push({ id, when });
  });

  // Decision table (exactly one in v1)
  let table: { id: string; hitPolicy: 'unique' | 'first'; rows: { when: TriState; outcome: string }[]; otherwise: string } | null = null;
  const tables = v.array(root.decisionTables, '$.decisionTables');
  if (tables.length !== 1) {
    errors.add('UNSUPPORTED_DECISION_TABLE_COUNT', '$.decisionTables', `Exactly one decision table is supported; got ${tables.length}`);
  }
  const tableObj = tables.length > 0 ? v.object(tables[0], '$.decisionTables[0]', ['id', 'hitPolicy', 'rows', 'otherwise']) : null;
  if (tableObj) {
    const p = '$.decisionTables[0]';
    const obj = tableObj;
    const id = v.id(obj.id, `${p}.id`);
    if (id) v.registerName(id, `${p}.id`);
    if (obj.hitPolicy !== undefined && obj.hitPolicy !== 'unique' && obj.hitPolicy !== 'first') {
      errors.add('INVALID_VALUE', `${p}.hitPolicy`, "Expected 'unique' or 'first'");
    }
    const rows: { when: TriState; outcome: string }[] = [];
    v.array(obj.rows, `${p}.rows`, true).forEach((r, j) => {
      const rp = `${p}.rows[${j}]`;
      const row = v.object(r, rp, ['when', 'outcome'], ['source']);
      if (!row) return;
      const when = row.when === undefined ? null : compileCondition(row.when, symbols, `${rp}.when`, errors);
      const outcome = outcomeRef(row.outcome, `${rp}.outcome`);
      v.sourceRef(row.source, `${rp}.source`, sourceIds);
      if (when && outcome) rows.push({ when, outcome });
    });
    const otherwise = outcomeRef(obj.otherwise, `${p}.otherwise`);
    if (id && otherwise && (obj.hitPolicy === 'unique' || obj.hitPolicy === 'first')) {
      table = { id, hitPolicy: obj.hitPolicy, rows, otherwise };
    }
  }

  for (const o of outcomes) {
    if (!referenced.has(o.id)) {
      errors.add('UNREACHABLE_OUTCOME', '$.outcomes', `Outcome '${o.id}' is never produced by the decision table or applicability`);
    }
  }

  // Ambiguities
  const openAmbiguities: { id: string; text: string }[] = [];
  const ambiguityIds = new Set<string>();
  v.array(root.ambiguities, '$.ambiguities').forEach((a, i) => {
    const p = `$.ambiguities[${i}]`;
    const obj = v.object(a, p, ['id', 'text', 'status', 'blocking'], ['sourceRef', 'resolution']);
    if (!obj) return;
    if (typeof obj.id !== 'string' || obj.id.trim() === '') errors.add('INVALID_VALUE', `${p}.id`, 'Expected an id');
    else if (ambiguityIds.has(obj.id)) errors.add('DUPLICATE_ID', `${p}.id`, `Ambiguity '${obj.id}' is listed twice`);
    else ambiguityIds.add(obj.id);
    v.plainString(obj.text, `${p}.text`);
    v.plainString(obj.resolution, `${p}.resolution`);
    if (obj.status !== undefined && obj.status !== 'open' && obj.status !== 'resolved') {
      errors.add('INVALID_VALUE', `${p}.status`, "Expected 'open' or 'resolved'");
    }
    if (obj.blocking !== undefined && typeof obj.blocking !== 'boolean') {
      errors.add('INVALID_VALUE', `${p}.blocking`, 'Expected true or false');
    }
    v.sourceRef(obj.sourceRef, `${p}.sourceRef`, sourceIds);
    if (obj.status === 'open' && obj.blocking === true) {
      errors.add('OPEN_BLOCKING_AMBIGUITY', p, `Ambiguity '${String(obj.id)}' is open and blocking: ${String(obj.text)}`);
    } else if (obj.status === 'open') {
      openAmbiguities.push({ id: String(obj.id), text: String(obj.text) });
    }
  });

  if (!errors.empty || !formId || !title || !table) {
    if (errors.empty) errors.add('INVALID_INPUT', '$', 'Input could not be compiled');
    return { ok: false, errors: errors.items };
  }

  const inputHash = sha256(canonicalJson(input));
  const xlsForm = buildXlsForm({
    formId, title, watermark, context, applicability, pages, questions, derived, table, outcomes,
    version: `v1_${inputHash.slice(0, 12)}`,
  });
  const properties = buildFormProperties(title, LANGUAGE, icon);

  const files = [
    { path: `forms/app/${formId}.xlsx`, bytes: xlsFormToXlsx(xlsForm) },
    { path: `forms/app/${formId}.properties.json`, bytes: new TextEncoder().encode(`${JSON.stringify(properties, null, 2)}\n`) },
  ].map((f) => ({ ...f, sha256: sha256(f.bytes) }));
  const artifactHash = sha256(
    [...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${f.path}\t${f.sha256}\n`).join(''),
  );

  const t = table;
  const manifest: CompileManifest = {
    manifestVersion: 1,
    compiler: { name: COMPILER_NAME, version: COMPILER_VERSION },
    logicModelSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    pathwayId: formId,
    formId,
    title,
    snapshotHash: options.snapshotHash ?? null,
    inputHash,
    artifactHash,
    options: { watermark, icon },
    files: files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes.length })),
    outputFields: {
      classification: t.id,
      referralUrgent: 'referral_urgent',
      followUpDays: 'follow_up_days',
      followUpDate: 't_follow_up_date',
      inScope: applicability ? 'in_scope' : null,
    },
    decisionTable: { id: t.id, hitPolicy: t.hitPolicy, rows: t.rows.length, otherwise: t.otherwise },
    outcomes: outcomes.map((o) => ({ id: o.id, referral: o.referral, followUpDays: o.followUpDays })),
    openAmbiguities,
  };

  return { ok: true, artifact: { formId, xlsForm, properties, files, manifest } };
}

interface BuildInput {
  formId: string;
  title: string;
  version: string;
  watermark: string | null;
  context: { id: string }[];
  applicability: { when: TriState; notApplicable: string; unknown: string } | null;
  pages: { id: string; label: string }[];
  questions: ValidQuestion[];
  derived: { id: string; when: TriState }[];
  table: { id: string; rows: { when: TriState; outcome: string }[]; otherwise: string };
  outcomes: ValidOutcome[];
}

function buildXlsForm(m: BuildInput): XlsForm {
  const label = `label::${LANGUAGE}`;
  const survey: XlsFormRow[] = [];
  const add = (row: XlsFormRow) => survey.push(row);
  const calc = (name: string, calculation: string) => add({ type: 'calculate', name, calculation });
  const warning = (text: string) => `<span style="color:red">${text}</span>`;

  add({ type: 'begin group', name: 'inputs', relevant: "./source = 'user'", appearance: 'field-list' });
  add({ type: 'hidden', name: 'source', default: 'user' });
  add({ type: 'hidden', name: 'source_id' });
  add({ type: 'begin group', name: 'contact' });
  add({ type: 'string', name: '_id', [label]: 'Who are you assessing?', appearance: 'select-contact type-person' });
  add({ type: 'hidden', name: 'name' });
  add({ type: 'hidden', name: 'patient_id' });
  add({ type: 'hidden', name: 'date_of_birth' });
  add({ type: 'begin group', name: 'parent' });
  add({ type: 'hidden', name: '_id' });
  add({ type: 'end group', name: 'parent' });
  add({ type: 'end group', name: 'contact' });
  add({ type: 'end group', name: 'inputs' });

  calc('patient_uuid', '../inputs/contact/_id');
  calc('patient_id', '../inputs/contact/patient_id');
  calc('patient_name', '../inputs/contact/name');
  for (const c of m.context) {
    calc(c.id, "if(../inputs/contact/date_of_birth = '', '', difference-in-months(../inputs/contact/date_of_birth, today()))");
  }
  const gate = m.applicability ? `${ref('in_scope')} = 'yes'` : null;
  if (m.applicability) {
    calc('in_scope', `if(${m.applicability.when.isTrue}, 'yes', if(${m.applicability.when.isFalse}, 'no', 'unknown'))`);
  }

  m.pages.forEach((page, index) => {
    const pageQuestions = m.questions.filter((q) => q.page === page.id);
    const relevance = pageQuestions.map((q) => questionRelevance(q, gate));
    const pageRelevant = index > 0 && relevance.every((r) => r !== '') ? orJoin(relevance) : '';
    add({ type: 'begin group', name: page.id, [label]: page.label, appearance: 'field-list', relevant: pageRelevant });
    if (index === 0 && m.watermark) add({ type: 'note', name: 'watermark_note', [label]: warning(m.watermark) });
    pageQuestions.forEach((q, i) => {
      const row: XlsFormRow = {
        type: q.type === 'boolean' ? 'select_one yes_no' : q.type === 'select_one' ? `select_one ${q.id}` : q.type,
        name: q.id,
        [label]: q.label,
        required: 'yes',
        relevant: relevance[i]!,
      };
      if (q.hint) row[`hint::${LANGUAGE}`] = q.hint;
      const bounds = [q.min !== undefined ? `. >= ${q.min}` : '', q.max !== undefined ? `. <= ${q.max}` : ''].filter(Boolean);
      if (bounds.length > 0) {
        row.constraint = bounds.join(' and ');
        row[`constraint_message::${LANGUAGE}`] =
          q.min !== undefined && q.max !== undefined ? `Enter a value from ${q.min} to ${q.max}.`
            : q.min !== undefined ? `Enter a value of at least ${q.min}.` : `Enter a value of at most ${q.max}.`;
      }
      add(row);
    });
    add({ type: 'end group', name: page.id });
  });

  for (const d of m.derived) calc(d.id, triStateCalculation(d.when));

  let chain = `'${m.table.otherwise}'`;
  for (const row of [...m.table.rows].reverse()) chain = `if(${row.when.isTrue}, '${row.outcome}', ${chain})`;
  if (m.applicability) {
    chain = `if(${ref('in_scope')} = 'unknown', '${m.applicability.unknown}', if(${ref('in_scope')} = 'no', '${m.applicability.notApplicable}', ${chain}))`;
  }
  calc(m.table.id, chain);

  const cls = ref(m.table.id);
  const urgent = m.outcomes.filter((o) => o.referral === 'urgent');
  calc('referral_urgent', urgent.length === 0 ? "'no'" : `if(${urgent.map((o) => `${cls} = '${o.id}'`).join(' or ')}, 'yes', 'no')`);
  let followUp = "''";
  for (const o of [...m.outcomes].reverse()) {
    if (o.followUpDays !== null) followUp = `if(${cls} = '${o.id}', ${o.followUpDays}, ${followUp})`;
  }
  calc('follow_up_days', followUp);
  calc('t_follow_up_date', `if(${ref('follow_up_days')} = '', '', date-time(decimal-date-time(today()) + ${ref('follow_up_days')}))`);

  add({ type: 'begin group', name: 'summary', [label]: 'Summary', appearance: 'field-list summary' });
  if (m.watermark) add({ type: 'note', name: 'summary_watermark_note', [label]: warning(m.watermark) });
  for (const o of m.outcomes) {
    const heading = o.referral === 'urgent' ? warning(o.label) : `**${o.label}**`;
    add({
      type: 'note',
      name: `outcome_${o.id}`,
      [label]: o.message ? `${heading}\n${o.message}` : heading,
      relevant: `${cls} = '${o.id}'`,
    });
  }
  add({ type: 'end group', name: 'summary' });

  const choices: XlsFormRow[] = [];
  if (m.questions.some((q) => q.type === 'boolean')) {
    choices.push({ list_name: 'yes_no', name: 'yes', [label]: 'Yes' }, { list_name: 'yes_no', name: 'no', [label]: 'No' });
  }
  for (const q of m.questions.filter((q) => q.type === 'select_one')) {
    for (const o of q.options) choices.push({ list_name: q.id, name: o.id, [label]: o.label });
  }

  const strip = (rows: XlsFormRow[]) =>
    rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, value]) => value !== '')));

  return {
    survey: { columns: SURVEY_COLUMNS, rows: strip(survey) },
    choices: { columns: ['list_name', 'name', label], rows: choices },
    settings: {
      columns: ['form_title', 'form_id', 'version', 'style', 'default_language'],
      rows: [{ form_title: m.title, form_id: m.formId, version: m.version, style: 'pages', default_language: LANGUAGE }],
    },
  };
}

function questionRelevance(q: ValidQuestion, gate: string | null): string {
  if (gate && q.relevance) return `(${gate} and ${q.relevance.isTrue})`;
  return gate ?? q.relevance?.isTrue ?? '';
}

function orJoin(exprs: string[]): string {
  const unique = [...new Set(exprs)];
  return unique.length === 1 ? unique[0]! : `(${unique.join(' or ')})`;
}
