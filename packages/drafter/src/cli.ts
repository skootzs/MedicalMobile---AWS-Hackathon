// Usage (from packages/drafter):
//   node src/cli.ts --mode practice --recorded test/fixtures/recorded/good.json --out /tmp/drafter-practice
//   BEDROCK_MODEL_ID=... node src/cli.ts --mode live --out /tmp/drafter-live
// Exit codes: 0 draft proposed, 1 blocked (see envelope.json), 2 usage or file error.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { draftLogicModel } from './draft.ts';
import { practiceClient, liveClient, liveConfigFromEnv, type ModelClient } from './bedrock.ts';

const DEFAULT_GUIDELINE = fileURLToPath(new URL('../../../fixtures/child-cough/guideline.md', import.meta.url));
const DEFAULT_REQUEST =
  'Create a CHW assessment form for children aged 2 months up to 5 years with cough or difficult breathing, ' +
  'following the WHO IMCI chart: general danger signs, breathing checks, classification and follow-up.';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'practice' },
      guideline: { type: 'string', default: DEFAULT_GUIDELINE },
      request: { type: 'string', default: DEFAULT_REQUEST },
      'request-file': { type: 'string' },
      recorded: { type: 'string' },
      'source-id': { type: 'string', default: 'who_imci_2014' },
      out: { type: 'string', default: 'drafter-output' },
    },
  });

  let client: ModelClient;
  if (values.mode === 'live') {
    client = await liveClient(liveConfigFromEnv());
  } else if (values.mode === 'practice') {
    if (!values.recorded) throw new Error('Practice mode needs --recorded <file.json>[,<file2.json>]');
    client = practiceClient(values.recorded.split(',').map((f) => resolve(f.trim())));
  } else {
    throw new Error('--mode must be practice or live');
  }

  const request = values['request-file'] ? readFileSync(values['request-file'], 'utf8') : values.request!;
  const result = await draftLogicModel({
    guidelineMarkdown: readFileSync(values.guideline!, 'utf8'),
    request,
    client,
    sourceId: values['source-id'],
  });

  const out = resolve(values.out!);
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'envelope.json'), JSON.stringify(result.envelope, null, 2) + '\n');
  if (result.logic) writeFileSync(resolve(out, 'logic.json'), JSON.stringify(result.logic, null, 2) + '\n');

  const e = result.envelope;
  const lines = [
    `Status: ${e.status.toUpperCase()}   (mode: ${e.provenance.mode}, model: ${e.provenance.modelId})`,
  ];
  if (e.status === 'blocked') {
    for (const b of e.blockers) lines.push(`Blocker [${b.kind}]:`, ...b.reasons.map((r) => `  - ${r}`));
  } else {
    const verified = e.citations.filter((c) => c.verified).length;
    lines.push(
      `Citations verified: ${verified} of ${e.citations.length}`,
      `Numbers found on cited pages: ${e.numbers.filter((n) => n.found).length} of ${e.numbers.length}`,
      `Ambiguities added by checks: ${e.addedAmbiguityIds.join(', ') || 'none'}`,
      `Open blocking ambiguities (need a clinician): ${e.openBlockingAmbiguities.join(', ') || 'none'}`,
      `Ready for the compiler once approved: ${e.compilable ? 'yes' : 'no, blocking ambiguities first'}`,
    );
  }
  lines.push(
    `Tokens: ${e.totals.inputTokens} in / ${e.totals.outputTokens} out   Cost: ${e.totals.estimatedCostUsd === null ? 'set PRICE_INPUT_PER_MTOK and PRICE_OUTPUT_PER_MTOK' : '$' + e.totals.estimatedCostUsd}`,
    `Files: ${out}/envelope.json${result.logic ? `, ${out}/logic.json` : ''}`,
  );
  console.log(lines.join('\n'));
  return e.status === 'proposed' ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(2);
  },
);
