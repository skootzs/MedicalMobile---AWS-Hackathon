/**
 * Case execution against the built form via the harness.
 *
 * A CaseExecutor turns one synthetic input into an `actual` outcome plus run
 * metadata. It NEVER decides whether an outcome is right, and it holds no
 * clinical constants (no age ranges, no thresholds). Page visibility is
 * discovered from the harness at run time (option B, below).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonValue } from './report.js';

/** A task emission as returned by the harness getTasks() API. */
export interface HarnessTask {
  emission?: { title?: unknown; dueDate?: unknown };
}

/**
 * Minimal shape of the harness we depend on, so this module stays testable.
 * getTasks/flush/getNow are optional: when absent, task observation is skipped
 * and no task fields are recorded.
 */
export interface HarnessLike {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  clear(): Promise<unknown>;
  setNow(now: string): unknown;
  fillForm(...args: unknown[]): Promise<FillResult>;
  getTasks?(): Promise<HarnessTask[]>;
  flush?(amount: number): Promise<unknown>;
  getNow?(): number;
}

export interface FillResult {
  report?: { fields?: Record<string, JsonValue> };
  errors?: Array<{ type?: string; msg?: string; section?: string }>;
}

/** The outcome of running one case, with no judgement attached. */
export interface ExecutionResult {
  /** Output fields observed from the submitted report; null if not submitted. */
  actual: Record<string, JsonValue> | null;
  /** Raw evidence: errors and notes, for the report's harnessOutput. */
  harnessOutput: string | null;
  /** True if the full page arrays were rejected and [[]] was used instead. */
  usedPageFallback: boolean;
  /**
   * 'ok'        - submitted (with or without fallback);
   * 'error'     - failed for a reason other than page-count fallback.
   * A fallback alone is never 'error'.
   */
  status: 'ok' | 'error';
}

export interface CaseInput {
  id: string;
  /** Opaque patient input; the executor reads only what it needs. */
  input: JsonValue;
}

export interface CaseExecutor {
  run(caseInput: CaseInput): Promise<ExecutionResult>;
}

// ---------------------------------------------------------------------------
// Form structure read from R5's compile-rows.json (no clinical values).

interface PageSpec {
  name: string;
  questions: string[];
}

/**
 * Derive the user-answerable page order and question names from compile-rows.json.
 * Excludes the hidden `inputs` group (the contact page, relevance source='user')
 * and note-only pages keep an empty question list. This reads structure only;
 * it never evaluates relevance or any clinical expression.
 */
export function derivePages(rowsFilePath: string): PageSpec[] {
  const parsed = JSON.parse(readFileSync(rowsFilePath, 'utf8')) as {
    survey?: { rows?: Array<{ type?: string; name?: string }> };
  };
  const rows = parsed.survey?.rows;
  if (!Array.isArray(rows)) {
    throw new Error('compile-rows.json: survey.rows missing or not an array');
  }
  const ANSWERABLE = /^(select_one|select_multiple|integer|decimal|text|date|time|dateTime)\b/;
  const pages: PageSpec[] = [];
  const groupStack: string[] = [];
  let current: PageSpec | null = null;
  for (const row of rows) {
    const type = row.type ?? '';
    if (type === 'begin group') {
      groupStack.push(row.name ?? '');
      // A top-level group (stack depth 1) that is not the inputs subtree opens a page.
      if (groupStack.length === 1 && row.name !== 'inputs') current = { name: row.name ?? '', questions: [] };
    } else if (type === 'end group') {
      if (groupStack.length === 1 && current) {
        pages.push(current);
        current = null;
      }
      groupStack.pop();
    } else if (current && ANSWERABLE.test(type)) {
      current.questions.push(row.name ?? '');
    }
  }
  return pages;
}

// ---------------------------------------------------------------------------
// PatientExecutor: option B (try full arrays, fall back to [[]] on the
// harness's "only N visible" page error).

/** The exact page-visibility error the harness emits (see Task 2). */
const PAGE_VISIBILITY_MSG = /Attempted to fill \d+ questions, but only \d+ are visible\./;

/**
 * The harness fills visible pages greedily in order, then raises the
 * page-visibility error on the first supplied array with no visible target.
 * Its error `section` resets per visible page, so it does NOT directly give
 * the count of arrays already consumed. The robust, clinical-constant-free
 * fallback is therefore progressive: retry with one fewer trailing page array
 * until the form submits, down to [[]]. Each retry relies solely on the
 * harness's accept/reject signal, never on an age or threshold rule.
 */

export interface PatientExecutorOptions {
  harness: HarnessLike;
  formId: string;
  /** Path to compile-rows.json for page/question derivation. */
  rowsFilePath: string;
  /** Fixed clock ('YYYY-MM-DD') so age and date calcs are deterministic. */
  fixedClock: string;
  /** Output field names to record, from manifest.outputFields plus extras. */
  outputFields: string[];
  /**
   * When true (and the harness supports getTasks/flush/getNow), record two
   * OBSERVED task fields on actual: `task_present` (bool) and
   * `task_due_in_days` (number of days from the fixed clock to the task's due
   * date, or null when absent). These are observations, never expected values.
   */
  observeTasks?: boolean;
  /** Days to scan forward for a follow-up task when observeTasks is on. */
  taskWindowDays?: number;
  /** Substring that identifies a follow-up task by its emission title. */
  followUpTitleMatch?: string;
}

const DAY_MS = 86_400_000;
const DEFAULT_TASK_WINDOW_DAYS = 10;

/**
 * Builds a contact whose date_of_birth yields the requested age in months
 * under the fixed clock (same day-of-month, exact difference-in-months), fills
 * the form, and records the output fields as `actual`.
 *
 * The age-to-dob arithmetic is calendar math only; it encodes no in-scope
 * range or any clinical rule.
 */
export class PatientExecutor implements CaseExecutor {
  constructor(private readonly opts: PatientExecutorOptions) {}

  /** dob ('YYYY-MM-DD') N months before the fixed clock, same day-of-month. */
  dobForAgeMonths(ageMonths: number): string {
    const [y, m, d] = this.opts.fixedClock.split('-').map(Number);
    const total = y * 12 + (m - 1) - ageMonths;
    const yy = Math.floor(total / 12);
    const mm = (total % 12) + 1;
    const pad = (n: number, w: number) => String(n).padStart(w, '0');
    return `${pad(yy, 4)}-${pad(mm, 2)}-${pad(d, 2)}`;
  }

  private async pick(result: FillResult): Promise<Record<string, JsonValue>> {
    const fields = result.report?.fields ?? {};
    const out: Record<string, JsonValue> = {};
    for (const key of this.opts.outputFields) out[key] = key in fields ? fields[key]! : null;
    if (this.opts.observeTasks) {
      const obs = await this.observeFollowUpTask();
      out['task_present'] = obs.task_present;
      out['task_due_in_days'] = obs.task_due_in_days;
    }
    return out;
  }

  /**
   * OBSERVATION only: scan forward up to taskWindowDays for a follow-up task
   * and record whether one appears and its due date relative to the fixed
   * clock. Requires getTasks/flush/getNow on the harness; if any is missing,
   * returns task_present:false / null without judgement. Writes no expected
   * value. The clock advanced by flush is reset by the next case's setNow.
   */
  private async observeFollowUpTask(): Promise<{ task_present: boolean; task_due_in_days: number | null }> {
    const h = this.opts.harness;
    if (!h.getTasks || !h.flush || !h.getNow) return { task_present: false, task_due_in_days: null };
    const match = this.opts.followUpTitleMatch ?? 'follow_up';
    const submitNow = h.getNow();
    const window = this.opts.taskWindowDays ?? DEFAULT_TASK_WINDOW_DAYS;
    for (let d = 0; d <= window; d++) {
      const tasks = await h.getTasks();
      const found = tasks.find((t) => t.emission && typeof t.emission.title === 'string' && t.emission.title.includes(match));
      if (found) {
        const due = found.emission!.dueDate;
        const dueMs = typeof due === 'number' ? due : Date.parse(String(due));
        const days = Number.isFinite(dueMs) ? Math.round((dueMs - submitNow) / DAY_MS) : null;
        return { task_present: true, task_due_in_days: days };
      }
      if (d < window) await h.flush(1);
    }
    return { task_present: false, task_due_in_days: null };
  }

  private isPageVisibilityError(result: FillResult): boolean {
    return (result.errors ?? []).some((e) => typeof e.msg === 'string' && PAGE_VISIBILITY_MSG.test(e.msg));
  }

  private otherErrors(result: FillResult): FillResult['errors'] {
    return (result.errors ?? []).filter((e) => !(typeof e.msg === 'string' && PAGE_VISIBILITY_MSG.test(e.msg)));
  }

  async run(caseInput: CaseInput): Promise<ExecutionResult> {
    const input = (caseInput.input ?? {}) as Record<string, JsonValue>;
    const ageMonths = input['ageMonths'];
    const pageAnswers = input['pageAnswers'];
    if (!Array.isArray(pageAnswers)) {
      return {
        actual: null,
        harnessOutput: 'input.pageAnswers must be an array of per-page answer arrays',
        usedPageFallback: false,
        status: 'error',
      };
    }

    const subject: Record<string, JsonValue> = { _id: 'subject', type: 'person', name: 'synthetic' };
    if (typeof ageMonths === 'number') subject['date_of_birth'] = this.dobForAgeMonths(ageMonths);
    // age null/absent => no date_of_birth (age_unknown path); not our decision.

    const loadArg = { form: this.opts.formId, subject, content: { source: 'contact', contact: subject } };

    await this.opts.harness.clear();
    this.opts.harness.setNow(this.opts.fixedClock);

    // First attempt: the full per-page arrays as supplied.
    let result: FillResult;
    try {
      result = await this.opts.harness.fillForm(loadArg, ...(pageAnswers as unknown[]));
    } catch (e) {
      return { actual: null, harnessOutput: `fillForm threw: ${String((e as Error).message ?? e)}`, usedPageFallback: false, status: 'error' };
    }

    if (result.report && this.otherErrors(result)!.length === 0) {
      return { actual: await this.pick(result), harnessOutput: null, usedPageFallback: false, status: 'ok' };
    }

    // Fallback only when the sole problem is page visibility (option B).
    // Progressive truncation: drop one trailing page array at a time and retry,
    // down to [[]], until the form submits. Stop immediately on any non-
    // visibility error (that is a real failure, never a fallback).
    if (this.isPageVisibilityError(result) && !result.report) {
      const full = pageAnswers as unknown[];
      for (let n = full.length - 1; n >= 0; n--) {
        const attempt = n === 0 ? [[]] : full.slice(0, n);
        await this.opts.harness.clear();
        this.opts.harness.setNow(this.opts.fixedClock);
        let fb: FillResult;
        try {
          fb = await this.opts.harness.fillForm(loadArg, ...attempt);
        } catch (e) {
          return { actual: null, harnessOutput: `fallback fillForm threw: ${String((e as Error).message ?? e)}`, usedPageFallback: true, status: 'error' };
        }
        const fbOther = this.otherErrors(fb)!;
        if (fb.report && fbOther.length === 0) {
          return {
            actual: await this.pick(fb),
            harnessOutput: `page-count fallback: full arrays had hidden pages; submitted after truncating to ${n} page array(s)${n === 0 ? ' ([[]])' : ''}`,
            usedPageFallback: true,
            status: 'ok',
          };
        }
        if (fbOther.length > 0 && !this.isPageVisibilityError(fb)) {
          // A real (non-visibility) failure: stop, record it as an error.
          return {
            actual: fb.report ? await this.pick(fb) : null,
            harnessOutput: `fallback (truncate to ${n}) failed with non-visibility error: ${JSON.stringify(fbOther)}`,
            usedPageFallback: true,
            status: 'error',
          };
        }
        // else: still a page-visibility error, keep truncating.
      }
      return {
        actual: null,
        harnessOutput: 'page-count fallback exhausted: form did not submit even with [[]]',
        usedPageFallback: true,
        status: 'error',
      };
    }

    // Any other failure is a real error, never dressed up as a fallback.
    // A required-but-unanswered visible question blocks submission; surface
    // that specific reason (H3). We deliberately do NOT map it to "incomplete".
    const blockedByRequired = (result.errors ?? []).some(
      (e) => typeof e.msg === 'string' && e.msg.includes('enketo.constraint.required'),
    );
    const harnessOutput = blockedByRequired
      ? `form blocked submission (required question unanswered): ${JSON.stringify(result.errors ?? [])}`
      : `harness errors: ${JSON.stringify(result.errors ?? [])}`;
    return {
      actual: result.report ? await this.pick(result) : null,
      harnessOutput,
      usedPageFallback: false,
      status: 'error',
    };
  }
}

/** Default output field list from the manifest plus the extras R5 named. */
export function outputFieldsFromManifest(manifest: {
  outputFields?: Record<string, string | null>;
}): string[] {
  const of = manifest.outputFields ?? {};
  const fromManifest = Object.values(of).filter((v): v is string => typeof v === 'string');
  // R5's assert list includes these which are not all in outputFields.
  const extras = ['in_scope', 'fast_breathing', 'any_general_danger_sign', 'patient_age_in_months'];
  return [...new Set([...fromManifest, ...extras])];
}

/** The manifest fields the runner reads. */
export interface CompileManifest {
  formId: string;
  snapshotHash: string | null;
  artifactHash: string;
  inputHash?: string;
  files?: Array<{ path: string; sha256: string; bytes?: number }>;
  translations?: Record<string, string>;
  outputFields?: Record<string, string | null>;
  decisionTable?: { otherwise?: unknown };
  outcomes?: Array<{ id?: unknown }>;
}

/** Resolve the manifest path's formId etc. */
export function readManifest(configDir: string): CompileManifest {
  const raw = JSON.parse(readFileSync(join(configDir, 'compile-manifest.json'), 'utf8'));
  if (typeof raw.formId !== 'string') throw new Error('compile-manifest.json: formId missing');
  if (typeof raw.artifactHash !== 'string') throw new Error('compile-manifest.json: artifactHash missing');
  return raw;
}

/** Resolved required branch set for coverage. */
export type ResolvedBranchIds =
  | { source: 'manifest'; branchIds: string[] }
  | { source: 'sample'; branchIds: string[]; warning: string };

/** Minimal executed-case shape needed to compute observed-outcome coverage. */
export interface CoverageCase {
  actual: Record<string, JsonValue> | null;
}

/**
 * Observed-outcome coverage: a branch is HIT only when some case has a non-null
 * actual whose classification field equals that branch id. A status-error case
 * (actual null) never counts. Returns covered/uncovered with a reason each. No
 * branch is excluded from the required set; there is no unreachable allowlist.
 */
export function computeObservedCoverage(
  branchIds: readonly string[],
  cases: readonly CoverageCase[],
  classificationField: string,
): {
  coveredBranchIds: string[];
  uncoveredBranches: { id: string; reason: string }[];
} {
  const hit = new Set<string>();
  for (const c of cases) {
    if (c.actual === null) continue;
    const cls = c.actual[classificationField];
    if (typeof cls === 'string') hit.add(cls);
  }
  const coveredBranchIds = branchIds.filter((id) => hit.has(id));
  const uncoveredBranches = branchIds
    .filter((id) => !hit.has(id))
    .map((id) => ({ id, reason: 'no executed case reached it' }));
  return { coveredBranchIds, uncoveredBranches };
}

/**
 * Branch ids from the manifest's outcomes (plus decisionTable.otherwise),
 * taken verbatim; or the supplied sample ids with an unconfirmed warning when
 * the manifest yields none. Mirrors synth's resolveBranchIds but reads the
 * already-parsed manifest object (verification does not depend on synth).
 */
export function resolveBranchIds(
  manifest: CompileManifest,
  sampleBranchIds: string[] | null,
): ResolvedBranchIds {
  const ids: string[] = [];
  for (const o of manifest.outcomes ?? []) {
    if (o && typeof o.id === 'string' && o.id.length > 0 && !ids.includes(o.id)) ids.push(o.id);
  }
  const otherwise = manifest.decisionTable?.otherwise;
  if (typeof otherwise === 'string' && otherwise.length > 0 && !ids.includes(otherwise)) {
    ids.push(otherwise);
  }
  if (ids.length > 0) return { source: 'manifest', branchIds: ids };
  return {
    source: 'sample',
    branchIds: sampleBranchIds ?? [],
    warning:
      'WARNING: branch ids come from unconfirmed sample data (the manifest had no outcomes) ' +
      'and must not be used as release evidence.',
  };
}
