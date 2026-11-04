#!/usr/bin/env node
// node src/cli.ts <logic-model.json> --golden <golden-cases.json>
// Exit 0 when the check passes, 1 when a blocking finding exists, 2 on usage errors.
import { readFileSync } from 'node:fs';
import { checkLogicModel } from './check.ts';

const args = process.argv.slice(2);
const modelPath = args[0];
const goldenFlag = args.indexOf('--golden');
const goldenPath = goldenFlag >= 0 ? args[goldenFlag + 1] : undefined;

if (!modelPath || modelPath.startsWith('--') || (goldenFlag >= 0 && !goldenPath)) {
  process.stderr.write('Usage: node src/cli.ts <logic-model.json> [--golden golden-cases.json]\n');
  process.exit(2);
}

let model: unknown;
let golden: unknown = [];
try {
  model = JSON.parse(readFileSync(modelPath, 'utf8'));
  if (goldenPath) golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const result = checkLogicModel(model, golden);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.outcome === 'PASS' ? 0 : 1);
