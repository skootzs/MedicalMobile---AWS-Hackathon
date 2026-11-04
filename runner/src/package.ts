import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { canonicalJson, sha256 } from './hashing.ts';

// shiv/ is cht-conf's Python unpack cache (SHIV_ROOT) and convert.log may vary between
// runs; neither is project content, and either would break packageHash determinism.
const EXCLUDED_FROM_PACKAGE = new Set(['shiv', 'convert.log']);

export interface PackageFile {
  path: string;
  absolute: string;
  executable: boolean;
}

export function listProjectFiles(root: string): PackageFile[] {
  const files: PackageFile[] = [];
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (!relative && EXCLUDED_FROM_PACKAGE.has(name)) continue;
      const absolute = join(root, path);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Refusing to package symlink: ${path}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path, absolute, executable: (stat.mode & 0o111) !== 0 });
      else throw new Error(`Refusing to package special file: ${path}`);
    }
  };
  walk('');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function splitPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Path too long for ustar: ${path}`);
}

function header(path: string, size: number, executable: boolean): Buffer {
  const block = Buffer.alloc(512);
  const { name, prefix } = splitPath(path);
  block.write(name, 0);
  block.write(octal(executable ? 0o755 : 0o644, 8), 100);
  block.write(octal(0, 8), 108);
  block.write(octal(0, 8), 116);
  block.write(octal(size, 12), 124);
  block.write(octal(0, 12), 136);
  block.write('        ', 148);
  block.write('0', 156);
  block.write('ustar\x0000', 257);
  block.write(prefix, 345);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

// Written in-process so every host gives identical bytes: sorted entries, mtime 0,
// uid/gid 0, no extended attributes. BSD and GNU tar disagree on all of these flags.
export function deterministicTgz(root: string): Buffer {
  const parts: Buffer[] = [];
  for (const file of listProjectFiles(root)) {
    const content = readFileSync(file.absolute);
    parts.push(header(file.path, content.length, file.executable), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  const gz = gzipSync(Buffer.concat(parts), { level: 9 });
  gz[9] = 3; // zlib stamps the OS byte per platform; pin it so hashes match across hosts.
  return gz;
}

export interface BuildManifest {
  manifestVersion: 1;
  files: { path: string; sha256: string }[];
  logs: { path: string; sha256: string }[];
}

export function buildManifest(root: string, logs: Record<string, string | Buffer>): { manifest: BuildManifest; bytes: string; manifestHash: string } {
  const manifest: BuildManifest = {
    manifestVersion: 1,
    files: listProjectFiles(root).map((file) => ({ path: file.path, sha256: sha256(readFileSync(file.absolute)) })),
    logs: Object.keys(logs).sort().map((path) => ({ path, sha256: sha256(logs[path]!) })),
  };
  const bytes = canonicalJson(manifest);
  return { manifest, bytes, manifestHash: sha256(bytes) };
}
