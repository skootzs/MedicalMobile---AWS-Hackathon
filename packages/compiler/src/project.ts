import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CompiledArtifact } from './compile.ts';

export const MANIFEST_FILE = 'compile-manifest.json';
export const ROWS_FILE = 'compile-rows.json';

// Writes the CHT files plus the manifest and the generated rows (for review) into an empty or new directory.
export function writeCompiledProject(artifact: CompiledArtifact, outDir: string): string[] {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`Output directory is not empty: ${outDir}`);
  }
  const written: string[] = [];
  const write = (relative: string, data: Uint8Array | string) => {
    const target = join(outDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    written.push(target);
  };
  for (const file of artifact.files) write(file.path, file.bytes);
  write(MANIFEST_FILE, `${JSON.stringify(artifact.manifest, null, 2)}\n`);
  write(ROWS_FILE, `${JSON.stringify(artifact.xlsForm, null, 2)}\n`);
  return written;
}
