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

export const TRANSLATIONS_FILE = 'translations/messages-en.properties';

/**
 * Reproduce R5's escapeProperty for a single translation value:
 *   backslash -> double backslash, then a single leading space -> "\ ".
 */
function escapeProperty(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/^ /, '\\ ');
}

/**
 * Reproduce R5's translationsFile exactly: keys sorted, each line
 * `key = value\n` with the value escaped by escapeProperty. These are the
 * GENERATED lines the compiler appends to the template's properties file and
 * the exact bytes the manifest hashes for TRANSLATIONS_FILE.
 */
export function generatedTranslations(translations: Record<string, string>): string {
  return Object.keys(translations)
    .sort()
    .map((k) => `${k} = ${escapeProperty(translations[k]!)}\n`)
    .join('');
}

/** The shape of compile-manifest.json fields this verification reads. */
export interface ManifestForVerify {
  artifactHash: string;
  files: Array<{ path: string; sha256: string; bytes?: number }>;
  translations?: Record<string, string>;
}

export interface FileVerifyResult {
  path: string;
  ok: boolean;
  detail: string;
}

export interface CompileArtifactVerification {
  ok: boolean;
  /** Per-file results plus the overall artifactHash-consistency result. */
  files: FileVerifyResult[];
  artifactHashOk: boolean;
}

/**
 * Verify the compiled artifact against its manifest, per file:
 *   - a normal generated file (e.g. xlsx, properties.json, tasks.js) is
 *     recomputed from disk and compared to its manifest sha256;
 *   - the translations file is regenerated from manifest.translations (the
 *     GENERATED lines only), its sha256 compared to the manifest entry, and
 *     the on-disk file is checked to CONTAIN those lines (the template's own
 *     lines are allowed and ignored);
 * and finally manifest.artifactHash is checked to equal the sha256 of the
 * sorted `path<TAB>sha256\n` lines over the manifest entries. No allowlists.
 */
export function verifyCompileArtifact(dir: string, manifest: ManifestForVerify): CompileArtifactVerification {
  const files: FileVerifyResult[] = [];
  for (const entry of manifest.files) {
    if (entry.path === TRANSLATIONS_FILE) {
      const generated = generatedTranslations(manifest.translations ?? {});
      const genSha = sha256(generated);
      const shaOk = genSha === entry.sha256;
      let onDisk = '';
      try {
        onDisk = readFileSync(join(dir, entry.path), 'utf8');
      } catch {
        files.push({ path: entry.path, ok: false, detail: `missing on disk; expected to contain the generated lines` });
        continue;
      }
      const contains = onDisk.includes(generated);
      files.push({
        path: entry.path,
        ok: shaOk && contains,
        detail: shaOk
          ? contains
            ? 'generated lines match manifest sha256 and are present in the on-disk file'
            : 'generated lines match manifest sha256 but are NOT present in the on-disk file'
          : `regenerated sha256 ${genSha} != manifest ${entry.sha256}`,
      });
    } else {
      let diskSha: string | null = null;
      try {
        diskSha = sha256(readFileSync(join(dir, entry.path)));
      } catch {
        files.push({ path: entry.path, ok: false, detail: 'missing on disk' });
        continue;
      }
      const ok = diskSha === entry.sha256;
      files.push({
        path: entry.path,
        ok,
        detail: ok ? 'disk sha256 matches manifest' : `disk sha256 ${diskSha} != manifest ${entry.sha256}`,
      });
    }
  }

  // artifactHash must equal the sha256 of the sorted `path<TAB>sha256\n` lines
  // over the manifest's own file entries.
  const recomputed = sha256(
    [...manifest.files]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((f) => `${f.path}\t${f.sha256}\n`)
      .join(''),
  );
  const artifactHashOk = recomputed === manifest.artifactHash;
  files.push({
    path: '(artifactHash)',
    ok: artifactHashOk,
    detail: artifactHashOk
      ? `manifest.artifactHash matches the sha256 over manifest file entries (${recomputed})`
      : `recomputed ${recomputed} != manifest.artifactHash ${manifest.artifactHash}`,
  });

  return { ok: files.every((f) => f.ok), files, artifactHashOk };
}
