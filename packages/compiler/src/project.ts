import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CompiledArtifact } from './compile.ts';
import { DIFF_FILE, type CompileDiff } from './diff.ts';
import { sha256 } from './hash.ts';

export const MANIFEST_FILE = 'compile-manifest.json';
export const ROWS_FILE = 'compile-rows.json';

export interface WriteOptions {
  /** CHT project to start from (e.g. templates/cht-base). Read only; copied into outDir before the generated files. */
  template?: string;
  /** Result of diffAgainstBaseline; written to compile-diff.json and summarised in the manifest. */
  diff?: CompileDiff;
}

export interface TemplateInfo {
  /** sha256 of the sorted lines `path<TAB>sha256` for every copied template file. */
  hash: string;
  files: number;
}

interface TemplateFile {
  path: string;
  bytes: Uint8Array;
}

// Git placeholders for empty folders; not part of the CHT project.
const SKIPPED_NAMES = new Set(['.gitkeep', '.DS_Store']);
// Generated translation keys are appended to the template's file of the same name instead of replacing it.
const MERGEABLE = /^translations\/messages-[a-z]{2,3}(-[A-Za-z]+)?\.properties$/;

function readTemplate(root: string): TemplateFile[] {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`Template is not a directory: ${root}`);
  const files: TemplateFile[] = [];
  const walk = (relative: string) => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      if (SKIPPED_NAMES.has(name)) continue;
      const rel = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(join(root, rel));
      if (stat.isDirectory()) walk(rel);
      else if (stat.isFile()) files.push({ path: rel, bytes: readFileSync(join(root, rel)) });
      else throw new Error(`Template contains a symlink or special file: ${rel}`);
    }
  };
  walk('');
  return files;
}

export function templateHash(files: { path: string; bytes: Uint8Array }[]): string {
  return sha256(
    files
      .map((f) => `${f.path}\t${sha256(f.bytes)}\n`)
      .sort()
      .join(''),
  );
}

function propertyKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const match = /^((?:\\.|[^=:\s\\])+)/.exec(trimmed);
    if (match) keys.add(match[1]!);
  }
  return keys;
}

function mergeProperties(path: string, template: Uint8Array, generated: Uint8Array): Uint8Array {
  const base = new TextDecoder().decode(template);
  const extra = new TextDecoder().decode(generated);
  const existing = propertyKeys(base);
  const clashes = [...propertyKeys(extra)].filter((k) => existing.has(k));
  if (clashes.length > 0) throw new Error(`Template ${path} already defines generated keys: ${clashes.join(', ')}`);
  const joiner = base === '' || base.endsWith('\n') ? '' : '\n';
  return new TextEncoder().encode(`${base}${joiner}${extra}`);
}

// Writes the template (if any), then the CHT files, the manifest and the generated rows into an empty or new directory.
// Everything is checked before the first write, so a failure leaves outDir untouched.
export function writeCompiledProject(artifact: CompiledArtifact, outDir: string, options: WriteOptions = {}): string[] {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`Output directory is not empty: ${outDir}`);
  }
  const template = options.template === undefined ? [] : readTemplate(options.template);
  const generated = new Set([
    ...artifact.files.map((f) => f.path).filter((p) => !MERGEABLE.test(p)),
    `forms/app/${artifact.formId}.xml`,
    MANIFEST_FILE,
    ROWS_FILE,
    DIFF_FILE,
  ]);
  const clashes = template.filter((f) => generated.has(f.path)).map((f) => f.path);
  if (clashes.length > 0) {
    throw new Error(`Template already contains generated files: ${clashes.join(', ')}`);
  }

  const output = new Map<string, Uint8Array>(template.map((f) => [f.path, f.bytes]));
  for (const file of artifact.files) {
    const existing = output.get(file.path);
    output.set(file.path, existing ? mergeProperties(file.path, existing, file.bytes) : file.bytes);
  }

  const templateInfo: TemplateInfo | null =
    options.template === undefined ? null : { hash: templateHash(template), files: template.length };
  const diff = options.diff;
  const manifest = {
    ...artifact.manifest,
    template: templateInfo,
    baseline: diff
      ? { ...diff.baseline, identical: diff.identical, warnings: diff.warnings.length, diffFile: DIFF_FILE }
      : null,
  };
  output.set(MANIFEST_FILE, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
  output.set(ROWS_FILE, new TextEncoder().encode(`${JSON.stringify(artifact.xlsForm, null, 2)}\n`));
  if (diff) output.set(DIFF_FILE, new TextEncoder().encode(`${JSON.stringify(diff, null, 2)}\n`));

  const written: string[] = [];
  for (const [relative, data] of output) {
    const target = join(outDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    written.push(target);
  }
  return written;
}
