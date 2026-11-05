import { GetObjectCommand } from '@aws-sdk/client-s3'
import { gunzipSync } from 'node:zlib'
import { canonicalJson } from '../../../compiler/src/hash.ts'
import { sha256 } from '../storage/durable-objects.ts'

const maxObjectBytes = 32 * 1024 * 1024

export class EvidenceError extends Error {}

export function pinnedReader(s3, bucket) {
  return async (ref, prefix) => {
    const root = `s3://${bucket}/${prefix}/`
    if (!ref?.uri?.startsWith(root) || !ref.versionId || ref.versionId === 'null' ||
        !/^[0-9a-f]{64}$/.test(ref.sha256)) throw new EvidenceError('INVALID_OBJECT_REFERENCE')
    const Key = ref.uri.slice(`s3://${bucket}/`.length)
    if (Key.split('/').some(part => !part || part === '..' || part === '.') || /[?#\\]/.test(Key)) {
      throw new EvidenceError('INVALID_OBJECT_KEY')
    }
    let response
    try {
      response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key, VersionId: ref.versionId }))
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404) throw new EvidenceError('MISSING_OBJECT_VERSION')
      throw error
    }
    if (response.VersionId !== ref.versionId || !response.ContentLength || response.ContentLength > maxObjectBytes) {
      response.Body?.destroy?.()
      throw new EvidenceError('INVALID_OBJECT_VERSION_OR_SIZE')
    }
    const bytes = Buffer.from(await response.Body.transformToByteArray())
    if (bytes.length !== response.ContentLength || (ref.size !== undefined && bytes.length !== ref.size) || sha256(bytes) !== ref.sha256) throw new EvidenceError('OBJECT_HASH_MISMATCH')
    return bytes
  }
}

// The runner emits regular ustar files only. Inspect bytes without extracting paths.
export function packageFiles(bytes) {
  const archive = gunzipSync(bytes, { maxOutputLength: 2 * maxObjectBytes })
  const files = new Map()
  const str = (block, start, end) => block.subarray(start, end).toString('utf8').split('\0')[0]
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      if (archive.length - offset !== 1024 || archive.subarray(offset).some(Boolean)) break
      return files
    }
    const sizeText = str(header, 124, 136)
    const size = /^[0-7]+$/.test(sizeText) ? parseInt(sizeText, 8) : NaN
    const name = str(header, 0, 100)
    const prefix = str(header, 345, 500)
    const path = prefix ? `${prefix}/${name}` : name
    const end = offset + 512 + size
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (str(header, 257, 263) !== 'ustar' || header[156] !== 48 ||
        parseInt(str(header, 148, 156), 8) !== checksum || !Number.isSafeInteger(size) || end > archive.length ||
        path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || files.has(path)) break
    files.set(path, archive.subarray(offset + 512, end))
    offset = Math.ceil(end / 512) * 512
  }
  throw new EvidenceError('INVALID_PROJECT_ARCHIVE')
}

export function compilationArtifacts(read) {
  return {
    async verify({ job, execution: row, model }) {
      try {
        const artifact = { uri: row.artifactUri, versionId: row.artifactVersionId, sha256: row.artifactHash }
        const manifest = { uri: row.manifestUri, versionId: row.manifestVersionId, sha256: row.manifestHash }
        const report = { uri: row.reportUri, versionId: row.reportVersionId, sha256: row.reportHash }
        const [pkg, manifestBytes, reportBytes] = await Promise.all([artifact, manifest, report].map(ref => read(ref, 'builds')))
        const files = packageFiles(pkg)
        const build = JSON.parse(manifestBytes)
        const compiled = JSON.parse(reportBytes)
        const inputHash = sha256(canonicalJson(model.content))
        if (build.manifestVersion !== 1 || compiled.manifestVersion !== 1 ||
            compiled.snapshotHash?.replace(/^sha256:/, '') !== job.logicModelHash ||
            inputHash !== row.inputHash || inputHash !== compiled.inputHash ||
            !files.get('compile-manifest.json')?.equals(reportBytes) ||
            !Array.isArray(build.files) || build.files.length !== files.size ||
            new Set(build.files.map(file => file.path)).size !== files.size ||
            !build.files.every(file => files.has(file.path) && sha256(files.get(file.path)) === file.sha256) ||
            !Array.isArray(compiled.files) || !compiled.files.length ||
            new Set(compiled.files.map(file => file.path)).size !== compiled.files.length ||
            !compiled.files.every(file => files.has(file.path) && files.get(file.path).length === file.bytes &&
              sha256(files.get(file.path)) === file.sha256)) throw new EvidenceError('COMPILE_MANIFEST_MISMATCH')
        const generated = compiled.files.map(file => `${file.path}\t${file.sha256}\n`).sort().join('')
        if (sha256(generated) !== row.compileArtifactHash || compiled.artifactHash !== row.compileArtifactHash) {
          throw new EvidenceError('GENERATED_FILES_MISMATCH')
        }
        return { status: 'VERIFIED', artifact: {
          verificationId: `artifact-${row.artifactHash}`, verifierId: 'pipeline-artifacts', verifierVersion: '1',
          jobId: job.jobId, attempt: row.attempt, executionRecordVersion: row.recordVersion,
          snapshotHash: model.snapshotHash, inputHash, generatedFilesHash: row.compileArtifactHash,
          manifestVersion: 1, templateHash: compiled.template?.hash,
          build: { conversionPassed: true, validationPassed: true, toolVersion: row.toolVersions.chtConf },
          packagedObject: { ...artifact, size: pkg.length }, manifest: { ...manifest, size: manifestBytes.length },
          report: { ...report, size: reportBytes.length }, compilerVersion: row.toolVersions.compiler,
          schemaVersion: model.schemaVersion, toolVersions: row.toolVersions, stage: 'CHT_CONVERTED',
          files: build.files.map(file => ({ path: file.path, sha256: file.sha256, size: files.get(file.path).length }))
        } }
      } catch (error) {
        if (error instanceof EvidenceError || error instanceof SyntaxError || error.code?.startsWith('Z_')) {
          return { status: 'INVALID', reason: 'COMPILED_ARTIFACT_INTEGRITY' }
        }
        return { status: 'UNAVAILABLE', reason: 'COMPILED_ARTIFACT_UNAVAILABLE' }
      }
    }
  }
}
