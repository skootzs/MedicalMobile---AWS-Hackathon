#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { compileLogicModel } from './compile.ts';
import { diffAgainstBaseline, type CompileDiff } from './diff.ts';
import { MANIFEST_FILE, ROWS_FILE, writeCompiledProject } from './project.ts';
import type { TaskWindow } from './tasks.ts';

const USAGE = `Usage: node src/cli.ts <logic-model.json> --out <dir> [--template <dir>] [--baseline <dir>]
       [--snapshot-hash <hash>] [--watermark <text>] [--icon <key>] [--task-window <start>,<end>]

  --template     CHT project copied into <dir> before the generated files (read only)
  --baseline     output folder of the previously deployed build; writes compile-diff.json
  --task-window  days before,after the follow-up date that the task shows (default 0,2)

Exit codes: 0 compiled, 1 the model was rejected (errors as JSON on stderr), 2 usage or file error.`;

function parseWindow(text: string): TaskWindow {
  const match = /^(\d+),(\d+)$/.exec(text);
  if (!match) throw new Error(`--task-window expects <start>,<end> in whole days, e.g. 0,2; got '${text}'`);
  return { start: Number(match[1]), end: Number(match[2]) };
}

function main(): number {
  let args;
  let taskWindow: TaskWindow | undefined;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        template: { type: 'string' },
        baseline: { type: 'string' },
        'snapshot-hash': { type: 'string' },
        watermark: { type: 'string' },
        icon: { type: 'string' },
        'task-window': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (args.values['task-window'] !== undefined) taskWindow = parseWindow(args.values['task-window']);
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
    taskWindow,
  });
  if (!result.ok) {
    console.error(JSON.stringify({ ok: false, errors: result.errors }, null, 2));
    return 1;
  }

  let manifest;
  let diff: CompileDiff | undefined;
  try {
    if (values.baseline !== undefined) {
      const read = (file: string) => JSON.parse(readFileSync(join(values.baseline!, file), 'utf8'));
      diff = diffAgainstBaseline(result.artifact, read(MANIFEST_FILE), read(ROWS_FILE));
    }
    writeCompiledProject(result.artifact, values.out, { template: values.template, diff });
    manifest = JSON.parse(readFileSync(join(values.out, MANIFEST_FILE), 'utf8'));
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const { formId, artifactHash, inputHash, files, template, baseline } = manifest;
  console.log(JSON.stringify({ ok: true, outDir: values.out, formId, artifactHash, inputHash, template, baseline, files }, null, 2));
  return 0;
}

process.exitCode = main();
