/**
 * Durable object provider backed by the local filesystem, for `local` demo mode.
 *
 * Implements the same DurableObjects port the DynamoDB adapter already relies
 * on, preserving its immutable, write-once-with-conflict-check semantics and
 * R2's canonical hashing (the content hash is the object identity). This is NOT
 * a fallback for AWS mode — it is only selected when MODE=local. It stands in
 * for S3 for a self-contained local demo; an S3-backed provider for AWS mode is
 * a later milestone.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { sha256 } from './durable-objects.ts';
import type { DurableObjects, ImmutableObjectReference } from './durable-objects.ts';

const URI_PREFIX = 's3://r2-local-objects/';

export class LocalObjectStore implements DurableObjects {
  readonly #directory: string;
  constructor(directory: string) {
    if (typeof directory !== 'string' || directory.trim() === '') throw new Error('LocalObjectStore requires a directory.');
    this.#directory = resolve(directory);
  }
  /** Reject any key that would escape the configured directory. */
  #path(key: string): string {
    const path = resolve(this.#directory, key);
    if (path !== this.#directory && !path.startsWith(this.#directory + sep)) throw new Error('Invalid object key.');
    return path;
  }
  /** Write-once: identical bytes are a harmless no-op; different bytes conflict. */
  async putIfAbsent(key: string, bytes: Uint8Array): Promise<ImmutableObjectReference> {
    const path = this.#path(key);
    await mkdir(resolve(path, '..'), { recursive: true });
    try {
      await writeFile(path, bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!Buffer.from(bytes).equals(await readFile(path))) throw new Error('Immutable object conflict.');
    }
    const digest = sha256(bytes);
    return { uri: `${URI_PREFIX}${key}`, versionId: digest, sha256: digest, size: bytes.length };
  }
  async read(ref: ImmutableObjectReference): Promise<Uint8Array> {
    if (ref.versionId !== ref.sha256) throw new Error('Invalid local object version.');
    if (!ref.uri.startsWith(URI_PREFIX)) throw new Error('Object reference is not from this provider.');
    return readFile(this.#path(ref.uri.slice(URI_PREFIX.length)));
  }
}
