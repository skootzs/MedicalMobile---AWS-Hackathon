import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CompiledArtifact } from './compile.ts';
import { sha256 } from './hash.ts';

export const MANIFEST_FILE = 'compile-manifest.json';
export const ROWS_FILE = 'compile-rows.json';

export interface WriteOptions {
  /** CHT project to start from (e.g. templates/cht-base). Read only; copied into outDir before the generated files. */
  template?: string;
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

// Writes the template (if any), then the CHT files, the manifest and the generated rows into an empty or new directory.
// Everything is checked before the first write, so a failure leaves outDir untouched.
export function writeCompiledProject(artifact: CompiledArtifact, outDir: string, options: WriteOptions = {}): string[] {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`Output directory is not empty: ${outDir}`);
  }
  const template = options.template === undefined ? [] : readTemplate(options.template);
  const generated = new Set([
    ...artifact.files.map((f) => f.path),
    `forms/app/${artifact.formId}.xml`,
    MANIFEST_FILE,
    ROWS_FILE,
  ]);
  const clashes = template.filter((f) => generated.has(f.path)).map((f) => f.path);
  if (clashes.length > 0) {
    throw new Error(`Template already contains generated files: ${clashes.join(', ')}`);
  }
  const templateInfo: TemplateInfo | null =
    options.template === undefined ? null : { hash: templateHash(template), files: template.length };

  const written: string[] = [];
  const write = (relative: string, data: Uint8Array | string) => {
    const target = join(outDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    written.push(target);
  };
  for (const file of template) write(file.path, file.bytes);
  for (const file of artifact.files) write(file.path, file.bytes);
  write(MANIFEST_FILE, `${JSON.stringify({ ...artifact.manifest, template: templateInfo }, null, 2)}\n`);
  write(ROWS_FILE, `${JSON.stringify(artifact.xlsForm, null, 2)}\n`);
  return written;
}
