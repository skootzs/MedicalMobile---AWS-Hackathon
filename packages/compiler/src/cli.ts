#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { compileLogicModel } from './compile.ts';
import { writeCompiledProject } from './project.ts';

const USAGE = `Usage: node src/cli.ts <logic-model.json> --out <dir> [--snapshot-hash <hash>] [--watermark <text>] [--icon <key>]

Exit codes: 0 compiled, 1 the model was rejected (errors as JSON on stderr), 2 usage or file error.`;

function main(): number {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        'snapshot-hash': { type: 'string' },
        watermark: { type: 'string' },
        icon: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = args;
  if (values.help || positionals.length !== 1 || !values.out) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }

  let input: unknown;
  try {
    input = JSON.parse(readFileSync(positionals[0]!, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${positionals[0]}: ${(err as Error).message}`);
    return 2;
  }

  const result = compileLogicModel(input, {
    snapshotHash: values['snapshot-hash'],
    watermark: values.watermark,
    icon: values.icon,
  });
  if (!result.ok) {
    console.error(JSON.stringify({ ok: false, errors: result.errors }, null, 2));
    return 1;
  }

  try {
    writeCompiledProject(result.artifact, values.out);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const { formId, artifactHash, inputHash, files } = result.artifact.manifest;
  console.log(JSON.stringify({ ok: true, outDir: values.out, formId, artifactHash, inputHash, files }, null, 2));
  return 0;
}

process.exitCode = main();
