/**
 * S3 object store tests using a faithful in-memory fake of the S3 commands the
 * adapter uses (conditional PutObject with If-None-Match, versioning, HeadObject,
 * versioned GetObject). This verifies the adapter's logic — content-addressed
 * keys, conditional writes, version capture, download integrity, conflict
 * detection, prefix enforcement — without a real S3 bucket.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3ObjectStore, ObjectStorageError } from '../src/storage/s3-objects.ts';
import { sha256, writeVerified, readVerified } from '../src/storage/durable-objects.ts';

interface StoredVersion { versionId: string; bytes: Buffer }
class PreconditionFailed extends Error { name = 'PreconditionFailed'; $metadata = { httpStatusCode: 412 }; }

/** Minimal versioned-bucket fake. Optionally corrupts stored bytes for a key. */
function fakeS3(opts: { corruptKey?: string; noVersion?: boolean } = {}) {
  const objects = new Map<string, StoredVersion[]>();
  let counter = 0;
  const client = {
    async send(command: unknown) {
      if (command instanceof PutObjectCommand) {
        const { Key, Body, IfNoneMatch } = command.input as { Key: string; Body: Buffer; IfNoneMatch?: string };
        if (IfNoneMatch === '*' && objects.has(Key)) throw new PreconditionFailed();
        const versionId = opts.noVersion ? '' : `v${++counter}`;
        const list = objects.get(Key) ?? [];
        list.push({ versionId, bytes: Buffer.from(Body) });
        objects.set(Key, list);
        return { VersionId: versionId };
      }
      if (command instanceof HeadObjectCommand) {
        const { Key } = command.input as { Key: string };
        const list = objects.get(Key);
        if (!list?.length) { const e = new Error('NotFound'); (e as { name: string }).name = 'NotFound'; throw e; }
        return { VersionId: list[list.length - 1].versionId };
      }
      if (command instanceof GetObjectCommand) {
        const { Key, VersionId } = command.input as { Key: string; VersionId?: string };
        const list = objects.get(Key);
        const found = list?.find(v => v.versionId === VersionId) ?? list?.[list.length - 1];
        if (!found) { const e = new Error('NoSuchKey'); (e as { name: string }).name = 'NoSuchKey'; throw e; }
        const bytes = opts.corruptKey === Key ? Buffer.from('corrupted') : found.bytes;
        return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
      }
      throw new Error('unexpected command');
    },
  } as unknown as S3Client;
  return { client, objects, injectDifferentBytes(key: string, bytes: Buffer, versionId: string) { objects.set(key, [{ versionId, bytes }]); } };
}

const store = (fake: ReturnType<typeof fakeS3>) => new S3ObjectStore({ client: fake.client, bucket: 'cht-nocode-artifacts-test' });
const payload = () => Buffer.from(JSON.stringify({ hello: 'fictional world' }));

test('putIfAbsent writes once, captures the version id, and is content-addressed', async () => {
  const fake = fakeS3();
  const s3 = store(fake);
  const bytes = payload();
  const key = `snapshots/${sha256(bytes)}.json`;
  const ref = await s3.putIfAbsent(key, bytes);
  assert.equal(ref.sha256, sha256(bytes));
  assert.equal(ref.size, bytes.length);
  assert.ok(ref.versionId, 'version id captured');
  assert.equal(ref.uri, `s3://cht-nocode-artifacts-test/${key}`);
});

test('repeated putIfAbsent of identical bytes is a harmless no-op (returns existing)', async () => {
  const fake = fakeS3();
  const s3 = store(fake);
  const bytes = payload();
  const key = `snapshots/${sha256(bytes)}.json`;
  const first = await s3.putIfAbsent(key, bytes);
  const second = await s3.putIfAbsent(key, bytes);
  assert.equal(second.sha256, first.sha256);
  assert.equal(fake.objects.get(key)!.length, 1, 'no second write occurred');
});

test('putIfAbsent rejects a conflicting write (same key, different bytes)', async () => {
  const fake = fakeS3();
  const s3 = store(fake);
  const bytes = payload();
  const key = `snapshots/${sha256(bytes)}.json`;
  // Pre-occupy the key with DIFFERENT bytes under the same (content-addressed) key.
  fake.injectDifferentBytes(key, Buffer.from('other bytes'), 'v0');
  await assert.rejects(() => s3.putIfAbsent(key, bytes),
    (e: unknown) => e instanceof ObjectStorageError && e.code === 'OBJECT_CONFLICT');
});

test('read verifies the downloaded digest and fails closed on corruption', async () => {
  const bytes = payload();
  const key = `snapshots/${sha256(bytes)}.json`;
  const clean = store(fakeS3());
  const ref = await clean.putIfAbsent(key, bytes);
  assert.deepEqual(Buffer.from(await clean.read(ref)), bytes);

  const corrupt = store(fakeS3({ corruptKey: key }));
  await corrupt.putIfAbsent(key, bytes); // stored, but read() returns corrupted bytes
  await assert.rejects(() => corrupt.read(ref),
    (e: unknown) => e instanceof ObjectStorageError && e.code === 'OBJECT_INTEGRITY');
});

test('fails closed when the bucket returns no version id (versioning disabled)', async () => {
  const s3 = store(fakeS3({ noVersion: true }));
  const bytes = payload();
  await assert.rejects(() => s3.putIfAbsent(`snapshots/${sha256(bytes)}.json`, bytes),
    (e: unknown) => e instanceof ObjectStorageError && e.code === 'OBJECT_VERSION_MISSING');
});

test('enforces R7 IAM write prefixes and rejects unsafe keys', async () => {
  const s3 = store(fakeS3());
  const bytes = payload();
  await assert.rejects(() => s3.putIfAbsent('secrets/leak.json', bytes),
    (e: unknown) => e instanceof ObjectStorageError && e.code === 'OBJECT_KEY_PREFIX_NOT_ALLOWED');
  await assert.rejects(() => s3.putIfAbsent('snapshots/../escape.json', bytes),
    (e: unknown) => e instanceof ObjectStorageError && e.code === 'INVALID_OBJECT_KEY');
  await assert.rejects(() => s3.putIfAbsent('/snapshots/x.json', bytes),
    (e: unknown) => e instanceof ObjectStorageError && e.code === 'INVALID_OBJECT_KEY');
});

test('read rejects an object reference for a different bucket', async () => {
  const s3 = store(fakeS3());
  await assert.rejects(() => s3.read({ uri: 's3://other-bucket/snapshots/x.json', versionId: 'v1', sha256: 'a'.repeat(64), size: 1 }),
    (e: unknown) => e instanceof ObjectStorageError && e.code === 'OBJECT_REFERENCE_SCOPE');
});

test('integrates with writeVerified/readVerified round-trip (snapshot-envelope path)', async () => {
  const s3 = store(fakeS3());
  const bytes = payload();
  const ref = await writeVerified(s3, `snapshots/${sha256(bytes)}.json`, bytes);
  assert.equal(ref.sha256, sha256(bytes));
  const back = await readVerified(s3, ref);
  assert.deepEqual(back, bytes);
});
