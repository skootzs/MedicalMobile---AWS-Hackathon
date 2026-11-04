// Orchestrates one drafting run: screen -> model -> format check (one retry) -> source checks -> result.
// Output: a bare LogicModel v1 (for R4 checks and, after approval, R5) plus an envelope for R2
// with provenance, screening, citation report, blockers and token/cost records.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseGuideline, sha256, type GuidelineSource } from './extract.ts';
import { screenInputs } from './screen.ts';
import { checkFormat, type FormatError } from './validate.ts';
import { verifySources, ambiguitiesFor } from './sources.ts';
import type { ModelClient, UsageRecord } from './bedrock.ts';

export const DRAFTER_VERSION = '0.1.0';
export const PROMPT_VERSION = 'draft-v2';
const PROMPT_TEXT = readFileSync(fileURLToPath(new URL('./prompts/draft.md', import.meta.url)), 'utf8');

export type BlockerKind = 'unusable_source' | 'personal_data' | 'schema_failure' | 'model_unavailable';

export interface Blocker {
  kind: BlockerKind;
  reasons: string[];
}

type CheckStatus = { status: 'pass' | 'flag'; detail: string };

export interface DraftEnvelope {
  draftId: string;
  status: 'proposed' | 'blocked';
  compilable: boolean;
  provenance: {
    drafterVersion: string;
    promptVersion: string;
    promptSha256: string;
    modelId: string;
    mode: 'live' | 'practice';
    sourceId: string;
    sourceUrl?: string;
    sourcePdfSha256?: string;
    guidelineTextSha256: string;
    extractorVersion: string;
    requestSha256: string;
    logicSha256?: string;
    createdAt: string;
  };
  screening: {
    input: { status: string; reasons: string[] };
    completeness: CheckStatus;
    ambiguities: CheckStatus;
    contradictions: CheckStatus;
    clinicalSafety: CheckStatus;
    feasibility: CheckStatus;
  };
  citations: ReturnType<typeof verifySources>['citations'];
  numbers: ReturnType<typeof verifySources>['numbers'];
  addedAmbiguityIds: string[];
  openBlockingAmbiguities: string[];
  blockers: Blocker[];
  usage: UsageRecord[];
  totals: { inputTokens: number; outputTokens: number; estimatedCostUsd: number | null };
}

export interface DraftResult {
  logic: Record<string, unknown> | null;
  envelope: DraftEnvelope;
}

export interface DraftOptions {
  guidelineMarkdown: string;
  request: string;
  client: ModelClient;
  sourceId?: string;
  promptText?: string;
  promptVersion?: string;
}

const TOOL_SCHEMA = {
  type: 'object',
  required: ['schemaVersion', 'pathwayId', 'title', 'language', 'sources', 'context', 'questions', 'derived', 'decisionTables', 'outcomes', 'ambiguities'],
  properties: {
    schemaVersion: { type: 'string', enum: ['1.0'] },
    pathwayId: { type: 'string' },
    title: { type: 'string' },
    language: { type: 'string', enum: ['en'] },
    sources: { type: 'array', items: { type: 'object' } },
    context: { type: 'array', items: { type: 'object' } },
    applicability: { type: 'object' },
    pages: { type: 'array', items: { type: 'object' } },
    questions: { type: 'array', items: { type: 'object' } },
    derived: { type: 'array', items: { type: 'object' } },
    decisionTables: { type: 'array', items: { type: 'object' } },
    outcomes: { type: 'array', items: { type: 'object' } },
    ambiguities: { type: 'array', items: { type: 'object' } },
  },
};

function buildPrompt(source: GuidelineSource, sourceId: string, request: string, errors?: FormatError[]): string {
  const pages = [...source.pages].map(([n, text]) => `<page number="${n}">\n${text}\n</page>`).join('\n');
  let prompt = `sourceId: ${sourceId}\nsource title: ${source.title}\n\n<request>\n${request}\n</request>\n\n<guideline>\n${pages}\n</guideline>`;
  if (errors?.length) {
    prompt += `\n\nYour previous answer was rejected by the format check. Fix ONLY these problems and resubmit the whole model:\n` +
      errors.slice(0, 30).map((e) => `- ${e.code} at ${e.path}: ${e.message}`).join('\n');
  }
  return prompt;
}

function totals(usage: UsageRecord[]) {
  const costs = usage.map((u) => u.estimatedCostUsd);
  return {
    inputTokens: usage.reduce((s, u) => s + u.inputTokens, 0),
    outputTokens: usage.reduce((s, u) => s + u.outputTokens, 0),
    estimatedCostUsd: costs.some((c) => c === null) ? null : costs.reduce((s: number, c) => s + (c ?? 0), 0),
  };
}

export async function draftLogicModel(opts: DraftOptions): Promise<DraftResult> {
  const source = parseGuideline(opts.guidelineMarkdown);
  const sourceId = opts.sourceId ?? 'who_imci_2014';
  const promptText = opts.promptText ?? PROMPT_TEXT;
  const usage: UsageRecord[] = [];
  const blockers: Blocker[] = [];
  const pending: CheckStatus = { status: 'flag', detail: 'Not reached' };

  const envelope: DraftEnvelope = {
    draftId: randomUUID(),
    status: 'blocked',
    compilable: false,
    provenance: {
      drafterVersion: DRAFTER_VERSION,
      promptVersion: opts.promptVersion ?? PROMPT_VERSION,
      promptSha256: sha256(promptText),
      modelId: opts.client.modelId,
      mode: opts.client.mode,
      sourceId,
      sourceUrl: source.url,
      sourcePdfSha256: source.pdfSha256,
      guidelineTextSha256: source.textSha256,
      extractorVersion: source.extractorVersion,
      requestSha256: sha256(opts.request),
      createdAt: new Date().toISOString(),
    },
    screening: { input: { status: 'ok', reasons: [] }, completeness: pending, ambiguities: pending, contradictions: pending, clinicalSafety: pending, feasibility: pending },
    citations: [],
    numbers: [],
    addedAmbiguityIds: [],
    openBlockingAmbiguities: [],
    blockers,
    usage,
    totals: totals(usage),
  };
  const finish = (logic: Record<string, unknown> | null): DraftResult => {
    envelope.totals = totals(usage);
    return { logic, envelope };
  };

  // 1. Screen inputs before any model call.
  const screening = screenInputs(source, opts.request);
  envelope.screening.input = screening;
  if (screening.status !== 'ok') {
    blockers.push({ kind: screening.status === 'unusable' ? 'unusable_source' : 'personal_data', reasons: screening.reasons });
    return finish(null);
  }
  const guardrail = await opts.client.screenText(opts.request);
  if (guardrail?.intervened) {
    envelope.screening.input = { status: 'rejected', reasons: guardrail.reasons };
    blockers.push({ kind: 'personal_data', reasons: guardrail.reasons });
    return finish(null);
  }

  // 2. Draft, check format, retry once with the errors (the compiler's { code, path, message } list).
  //    A first answer that compiles but lacks sources is kept if the retry is worse.
  let output: unknown = null;
  let usable: unknown = null;
  let feedback: FormatError[] | undefined;
  let formatErrors: FormatError[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await opts.client.invoke({
        purpose: 'draft_logic_model',
        system: promptText,
        prompt: buildPrompt(source, sourceId, opts.request, feedback),
        toolName: 'submit_logic_model',
        toolDescription: 'Submit the drafted LogicModel v1 object.',
        toolSchema: TOOL_SCHEMA,
      }, attempt);
      usage.push(res.usage);
      output = res.output;
    } catch (err) {
      const failed = (err as { usage?: UsageRecord }).usage;
      if (failed) usage.push(failed);
      if (usable) break;
      blockers.push({ kind: 'model_unavailable', reasons: [(err as Error).message] });
      return finish(null);
    }
    const check = await checkFormat(output);
    if (check.ok) {
      usable = output;
      formatErrors = [];
      if (check.sourceErrors.length === 0) break;
      feedback = check.sourceErrors;
    } else {
      formatErrors = check.errors;
      feedback = [...check.errors, ...check.sourceErrors];
    }
  }
  if (!usable) {
    blockers.push({ kind: 'schema_failure', reasons: formatErrors.map((e) => `${e.code} at ${e.path}: ${e.message}`) });
    return finish(null);
  }
  output = usable;
  const logic = output as Record<string, unknown>;

  // 3. Fill source metadata from the guideline file (metadata only, never clinical content).
  for (const s of (logic.sources as Record<string, unknown>[]) ?? []) {
    if (s.id === sourceId) {
      if (source.url) s.url = source.url;
      if (source.pdfSha256) s.sha256 = source.pdfSha256;
    }
  }

  // 4. Deterministic source checks -> extra ambiguities inside the model.
  const report = verifySources(logic, source);
  envelope.citations = report.citations;
  envelope.numbers = report.numbers;
  const ambiguities = logic.ambiguities as Record<string, unknown>[];
  const added = ambiguitiesFor(report, sourceId, new Set(ambiguities.map((a) => String(a.id))));
  ambiguities.push(...added.map((a) => ({ ...a })));
  envelope.addedAmbiguityIds = added.map((a) => a.id);

  // 5. Final check on the enriched model, then screening summary for R2.
  const final = await checkFormat(logic);
  if (!final.ok) {
    blockers.push({ kind: 'schema_failure', reasons: final.errors.map((e) => `${e.code} at ${e.path}: ${e.message}`) });
    return finish(null);
  }
  const open = ambiguities.filter((a) => a.status === 'open');
  const openBlocking = open.filter((a) => a.blocking === true);
  const conflicts = open.filter((a) => /^\s*conflict/i.test(String(a.text)));
  const badCitations = report.citations.filter((c) => !c.verified);
  const badNumbers = report.numbers.filter((n) => !n.found);

  envelope.status = 'proposed';
  envelope.compilable = openBlocking.length === 0;
  envelope.openBlockingAmbiguities = openBlocking.map((a) => String(a.id));
  envelope.provenance.logicSha256 = sha256(JSON.stringify(logic));
  envelope.screening.completeness = { status: 'pass', detail: `Format accepted by the ${final.checker} check` };
  envelope.screening.ambiguities = open.length
    ? { status: 'flag', detail: `${open.length} open (${openBlocking.length} blocking): a clinician must resolve blocking ones` }
    : { status: 'pass', detail: 'No open ambiguities' };
  envelope.screening.contradictions = conflicts.length
    ? { status: 'flag', detail: `${conflicts.length} conflicting passage(s) flagged` }
    : { status: 'pass', detail: 'No conflicts flagged' };
  envelope.screening.clinicalSafety = badCitations.length || badNumbers.length
    ? { status: 'flag', detail: `${badCitations.length} citation(s) missing or not found in source, ${badNumbers.length} number(s) not found on cited page` }
    : { status: 'pass', detail: `All ${report.citations.length} citations and ${report.numbers.length} numbers verified against the source` };
  envelope.screening.feasibility = { status: 'pass', detail: 'Uses only constructs the compiler supports' };
  return finish(logic);
}
