// The ONLY place the drafter talks to a model.
// live:     Amazon Bedrock Converse API, model ID from configuration, forced tool output.
// practice: replays saved model answers from files, so everything else can be tested without AWS.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface UsageRecord {
  callId: string;
  purpose: string;
  mode: 'live' | 'practice';
  modelId: string;
  attempt: number;
  ok: boolean;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  tokensEstimated: boolean;
  latencyMs: number;
  estimatedCostUsd: number | null;
}

export interface ModelRequest {
  purpose: string;
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  toolSchema: Record<string, unknown>;
}

export interface GuardrailResult {
  intervened: boolean;
  reasons: string[];
}

export interface ModelClient {
  mode: 'live' | 'practice';
  modelId: string;
  /** Returns the tool input the model produced (or raw text if it produced no valid JSON). */
  invoke(req: ModelRequest, attempt: number): Promise<{ output: unknown; usage: UsageRecord }>;
  screenText(text: string): Promise<GuardrailResult | null>;
}

export interface LiveConfig {
  modelId: string;
  region: string;
  timeoutMs: number;
  guardrailId?: string;
  guardrailVersion?: string;
  priceInputPerMTok?: number;
  priceOutputPerMTok?: number;
}

export function liveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const modelId = env.BEDROCK_MODEL_ID?.trim();
  if (!modelId) throw new Error('BEDROCK_MODEL_ID is not set. Copy the model ID from the Bedrock console.');
  const num = (v: string | undefined) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  return {
    modelId,
    region: env.AWS_REGION?.trim() || 'us-west-2',
    timeoutMs: num(env.BEDROCK_TIMEOUT_MS) ?? 120_000,
    guardrailId: env.GUARDRAIL_ID?.trim() || undefined,
    guardrailVersion: env.GUARDRAIL_VERSION?.trim() || undefined,
    priceInputPerMTok: num(env.PRICE_INPUT_PER_MTOK),
    priceOutputPerMTok: num(env.PRICE_OUTPUT_PER_MTOK),
  };
}

function cost(cfg: { priceInputPerMTok?: number; priceOutputPerMTok?: number }, inTok: number, outTok: number): number | null {
  if (cfg.priceInputPerMTok === undefined || cfg.priceOutputPerMTok === undefined) return null;
  return Math.round(((inTok * cfg.priceInputPerMTok + outTok * cfg.priceOutputPerMTok) / 1_000_000) * 1e6) / 1e6;
}

// ---------- practice mode ----------

export function practiceClient(recordedFiles: string[]): ModelClient {
  let next = 0;
  return {
    mode: 'practice',
    modelId: 'practice-recorded',
    async invoke(req, attempt) {
      const file = recordedFiles[Math.min(next, recordedFiles.length - 1)];
      next += 1;
      if (!file) throw new Error('Practice mode needs at least one --recorded file');
      const raw = readFileSync(file, 'utf8');
      let output: unknown = raw;
      try {
        output = JSON.parse(raw);
      } catch {
        /* leave as raw text: the validator will reject it */
      }
      const inputTokens = Math.ceil((req.system.length + req.prompt.length) / 4);
      const outputTokens = Math.ceil(raw.length / 4);
      return {
        output,
        usage: {
          callId: randomUUID(), purpose: req.purpose, mode: 'practice', modelId: 'practice-recorded', attempt,
          ok: true, inputTokens, outputTokens, cacheReadTokens: 0, tokensEstimated: true, latencyMs: 0, estimatedCostUsd: 0,
        },
      };
    },
    async screenText() {
      return null; // Guardrails only runs in live mode
    },
  };
}

// ---------- live mode (Amazon Bedrock) ----------

const RETRYABLE = new Set([
  'ThrottlingException', 'ServiceUnavailableException', 'ModelNotReadyException',
  'InternalServerException', 'TimeoutError', 'AbortError',
]);
const MAX_TRANSPORT_RETRIES = 2;

export async function liveClient(cfg: LiveConfig): Promise<ModelClient> {
  // Loaded only in live mode, so practice mode needs no npm install.
  const sdk = await import('@aws-sdk/client-bedrock-runtime');
  const client = new sdk.BedrockRuntimeClient({ region: cfg.region, maxAttempts: 1 });

  return {
    mode: 'live',
    modelId: cfg.modelId,
    async invoke(req, attempt) {
      let lastError: unknown;
      for (let transport = 0; transport <= MAX_TRANSPORT_RETRIES; transport++) {
        const started = Date.now();
        try {
          const res = await client.send(
            new sdk.ConverseCommand({
              modelId: cfg.modelId,
              system: [{ text: req.system }],
              messages: [{ role: 'user', content: [{ text: req.prompt }] }],
              toolConfig: {
                tools: [{ toolSpec: { name: req.toolName, description: req.toolDescription, inputSchema: { json: req.toolSchema as never } } }],
                toolChoice: { tool: { name: req.toolName } },
              },
              inferenceConfig: { maxTokens: 8000 },
            }),
            { abortSignal: AbortSignal.timeout(cfg.timeoutMs) },
          );
          const blocks = res.output?.message?.content ?? [];
          const toolUse = blocks.find((b) => b.toolUse)?.toolUse;
          const text = blocks.map((b) => b.text ?? '').join('');
          const inTok = res.usage?.inputTokens ?? 0;
          const outTok = res.usage?.outputTokens ?? 0;
          return {
            output: toolUse ? toolUse.input : text,
            usage: {
              callId: randomUUID(), purpose: req.purpose, mode: 'live', modelId: cfg.modelId, attempt, ok: true,
              inputTokens: inTok, outputTokens: outTok, cacheReadTokens: res.usage?.cacheReadInputTokens ?? 0,
              tokensEstimated: false, latencyMs: res.metrics?.latencyMs ?? Date.now() - started,
              estimatedCostUsd: cost(cfg, inTok, outTok),
            },
          };
        } catch (err) {
          lastError = err;
          const name = (err as { name?: string }).name ?? '';
          if (!RETRYABLE.has(name) || transport === MAX_TRANSPORT_RETRIES) break;
          await new Promise((r) => setTimeout(r, 1000 * 3 ** transport));
        }
      }
      const message = (lastError as Error)?.message ?? String(lastError);
      const failed: UsageRecord = {
        callId: randomUUID(), purpose: req.purpose, mode: 'live', modelId: cfg.modelId, attempt, ok: false, error: message,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, tokensEstimated: false, latencyMs: 0, estimatedCostUsd: null,
      };
      throw Object.assign(new Error(`Bedrock call failed: ${message}`), { usage: failed });
    },
    async screenText(text) {
      if (!cfg.guardrailId || !cfg.guardrailVersion) return null;
      const res = await client.send(
        new sdk.ApplyGuardrailCommand({
          guardrailIdentifier: cfg.guardrailId,
          guardrailVersion: cfg.guardrailVersion,
          source: 'INPUT',
          content: [{ text: { text } }],
        }),
      );
      const intervened = res.action === 'GUARDRAIL_INTERVENED';
      const reasons = intervened
        ? (res.assessments ?? []).flatMap((a) => (a.sensitiveInformationPolicy?.piiEntities ?? []).map((p) => `Guardrail found ${p.type}`))
        : [];
      return { intervened, reasons: intervened && reasons.length === 0 ? ['Guardrail intervened'] : reasons };
    },
  };
}
