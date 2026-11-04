/**
 * Deterministic hashes over files on disk. No model calls, no clinical logic.
 *
 * Two directory-level hashes are built with the same line format R5's compiler
 * uses: for each file, `${relativePath}\t${sha256(bytes)}\n`, the lines sorted,
 * then joined with no separator, and sha256'd. Paths use forward slashes.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Lowercase hex sha256 of raw bytes or a string. */
export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Relative POSIX paths of every file under dir, recursively, sorted. */
export function listFilesRelative(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs).sort()) {
      const child = join(abs, name);
      const st = statSync(child);
      if (st.isDirectory()) walk(child);
      else if (st.isFile()) out.push(relative(dir, child).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Hash a specific set of files under dir, using R5's `path\tsha256\n` lines,
 * sorted by the full line, joined with no separator. The caller passes the
 * exact relative paths, so this is used for compileArtifactHash (the two
 * generated files) with no directory knowledge baked in.
 */
export function hashFileSet(dir: string, relativePaths: readonly string[]): string {
  const lines = relativePaths.map((p) => `${p}\t${sha256(readFileSync(join(dir, p)))}\n`).sort();
  return sha256(lines.join(''));
}

/** Hash every file under dir (including .xml), same line format. */
export function hashDirectory(dir: string): string {
  return hashFileSet(dir, listFilesRelative(dir));
}

/**
 * compileArtifactHash: R5's algorithm over exactly the two generated files for
 * a form, `forms/app/<formId>.xlsx` and `forms/app/<formId>.properties.json`.
 * The .xml is intentionally excluded. formId comes from the manifest.
 */
export function compileArtifactHash(dir: string, formId: string): string {
  return hashFileSet(dir, [
    `forms/app/${formId}.xlsx`,
    `forms/app/${formId}.properties.json`,
  ]);
}
