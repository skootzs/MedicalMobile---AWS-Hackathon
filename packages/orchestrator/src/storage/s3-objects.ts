/**
 * Immutable S3-backed durable object provider for AWS mode.
 *
 * Implements the existing DurableObjects port, preserving its write-once
 * semantics and R2's content-addressed identity: the object key embeds the
 * SHA-256 of the bytes, so the same content always maps to the same key and
 * differing content can never occupy it. Writes are conditional
 * (If-None-Match: *) so a concurrent or repeated write of identical bytes is a
 * harmless no-op and a conflicting write is rejected. The S3 object version id
 * is captured on the returned reference. Reads verify length and SHA-256 before
 * the bytes are trusted (readVerified in durable-objects.ts re-checks too).
 *
 * This writes ONLY under the bucket prefixes R7's IAM policy permits
 * (snapshots/, builds/, previews/, sources/). It never deletes (no DeleteObject
 * in the app-host policy) and never creates a bucket. S3 I/O is deliberately
 * separate from any DynamoDB transaction: the DynamoDB adapter writes objects
 * first, then commits the table transaction referencing them.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import type { DurableObjects, ImmutableObjectReference } from './durable-objects.ts';
import { sha256 } from './durable-objects.ts';

/** Prefixes R7's app-host IAM policy allows s3:PutObject on. */
const ALLOWED_PREFIXES = ['snapshots/', 'builds/', 'previews/', 'sources/'] as const;

export interface S3ObjectStoreOptions {
  client: S3Client;
  bucket: string;
}

export class ObjectStorageError extends Error {
  readonly code: string;
  constructor(code: string, message = code) { super(message); this.name = 'ObjectStorageError'; this.code = code; }
}

function assertAllowedKey(key: string): void {
  if (typeof key !== 'string' || key === '' || key.includes('..') || key.startsWith('/')) {
    throw new ObjectStorageError('INVALID_OBJECT_KEY', `Rejected object key: ${JSON.stringify(key)}.`);
  }
  if (!ALLOWED_PREFIXES.some(prefix => key.startsWith(prefix))) {
    throw new ObjectStorageError('OBJECT_KEY_PREFIX_NOT_ALLOWED', `Object key must start with one of ${ALLOWED_PREFIXES.join(', ')}.`);
  }
}

async function toBytes(body: unknown): Promise<Buffer> {
  // Node SDK returns a stream; transformToByteArray is available on it.
  if (body && typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    return Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray());
  }
  throw new ObjectStorageError('OBJECT_BODY_UNREADABLE', 'S3 object body is not readable.');
}

export class S3ObjectStore implements DurableObjects {
  readonly #client: S3Client;
  readonly #bucket: string;
  constructor(options: S3ObjectStoreOptions) {
    if (!options?.client || !options.bucket) throw new ObjectStorageError('S3_CONFIGURATION_REQUIRED');
    this.#client = options.client;
    this.#bucket = options.bucket;
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<ImmutableObjectReference> {
    assertAllowedKey(key);
    const buffer = Buffer.from(bytes);
    const digest = sha256(buffer);
    try {
      // Conditional create: fails if the key already exists.
      const put = await this.#client.send(new PutObjectCommand({
        Bucket: this.#bucket, Key: key, Body: buffer,
        IfNoneMatch: '*',
        ContentType: 'application/json',
      }));
      const versionId = put.VersionId;
      if (typeof versionId !== 'string' || versionId === '') {
        // Bucket versioning is required (R7's s3.tf enables it); fail closed.
        throw new ObjectStorageError('OBJECT_VERSION_MISSING', 'S3 did not return a version id; bucket versioning must be enabled.');
      }
      return { uri: `s3://${this.#bucket}/${key}`, versionId, sha256: digest, size: buffer.length };
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      // Key already exists: accept ONLY if the stored bytes are byte-identical.
      const existing = await this.#headVerified(key, digest, buffer.length);
      return existing;
    }
  }

  /** On conflict, confirm the existing object is byte-identical (content-addressed). */
  async #headVerified(key: string, expectedSha: string, expectedSize: number): Promise<ImmutableObjectReference> {
    const head = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
    const versionId = head.VersionId;
    if (typeof versionId !== 'string' || versionId === '') throw new ObjectStorageError('OBJECT_VERSION_MISSING');
    // Read the stored bytes RAW (no digest assumption) and compare to the bytes
    // we were asked to write. A genuine difference is a conflict; identical bytes
    // mean the prior write already succeeded and this call is a safe no-op.
    const got = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key, VersionId: versionId }));
    const bytes = await toBytes(got.Body);
    if (bytes.length !== expectedSize || sha256(bytes) !== expectedSha) {
      throw new ObjectStorageError('OBJECT_CONFLICT', 'An object with different bytes already occupies this key.');
    }
    return { uri: `s3://${this.#bucket}/${key}`, versionId, sha256: expectedSha, size: expectedSize };
  }

  async read(ref: ImmutableObjectReference): Promise<Uint8Array> {
    if (!ref || typeof ref.uri !== 'string' || typeof ref.versionId !== 'string' || ref.versionId === '') {
      throw new ObjectStorageError('INVALID_OBJECT_REFERENCE');
    }
    const key = this.#keyFromUri(ref.uri);
    const got = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key, VersionId: ref.versionId }));
    const bytes = await toBytes(got.Body);
    // Integrity is also re-checked by readVerified(); this is defense in depth.
    if (typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256) && sha256(bytes) !== ref.sha256) {
      throw new ObjectStorageError('OBJECT_INTEGRITY', 'Downloaded S3 bytes do not match the expected digest.');
    }
    return bytes;
  }

  #keyFromUri(uri: string): string {
    const prefix = `s3://${this.#bucket}/`;
    if (!uri.startsWith(prefix)) throw new ObjectStorageError('OBJECT_REFERENCE_SCOPE', 'Object reference is not for this bucket.');
    return uri.slice(prefix.length);
  }
}

/** S3 returns 412 PreconditionFailed when If-None-Match: * hits an existing key. */
function isPreconditionFailed(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412;
}
