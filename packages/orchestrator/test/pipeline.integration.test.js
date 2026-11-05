import assert from 'node:assert/strict'
import { CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createIntakeApp } from '../../intake/server.js'
import { createStore } from '../../intake/storage.js'
import { practiceClient } from '../../drafter/src/bedrock.ts'
import { dockerStages } from '../../../runner/launch-build.ts'
import { JobStore } from '../../../runner/src/store.ts'
import { Worker } from '../../../runner/src/worker.ts'
import { FakeQueue, FakeStages, Harness, OK } from '../../../runner/test/helpers.ts'
import { bootstrap } from '../src/bootstrap.ts'
import { createDemoIdentity } from '../src/demo-identity.ts'
import { compilationArtifacts, pinnedReader } from '../src/integrated/artifacts.js'
import { pipelineHttp } from '../src/integrated/http.js'
import { checkerPolicies, createPipeline, evidenceCatalog, pipelineIdentity } from '../src/integrated/pipeline.js'
import { resolveRunnerServiceActor } from '../src/service-actors.ts'
import { sha256 } from '../src/storage/durable-objects.ts'
import { createLocalTable, localClient } from './helpers/dynamodb-local-fixtures.ts'
import { fictionalReport } from './helpers/verification-report-fixtures.ts'

const endpoint = process.env.R2_DYNAMODB_LOCAL_ENDPOINT
const liveContainers = process.env.PIPELINE_DOCKER === '1'
const fixture = path => new URL(`../../../fixtures/child-cough/${path}`, import.meta.url)

test('confirmed intake runs through independent approvals to the exact download', { skip: !endpoint, timeout: 900_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'medic-pipeline-'))
  chmodSync(dir, 0o755)
  const { client, document } = localClient(endpoint)
  const table = `r2-local-test-${randomUUID()}`
  const intakeTable = `r2-local-test-${randomUUID()}`
  await createLocalTable(client, table)
  await client.send(new CreateTableCommand({
    TableName: intakeTable, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      ...['pk', 'sk', 'pipelineQueue'].map(AttributeName => ({ AttributeName, AttributeType: 'S' })),
      { AttributeName: 'due', AttributeType: 'N' }
    ],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    GlobalSecondaryIndexes: [{ IndexName: 'pipeline-due',
      KeySchema: [{ AttributeName: 'pipelineQueue', KeyType: 'HASH' }, { AttributeName: 'due', KeyType: 'RANGE' }],
      Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['kind', 'revisionId'] } }]
  }))
  t.after(async () => {
    await Promise.all([table, intakeTable].map(TableName => client.send(new DeleteTableCommand({ TableName }))))
    client.destroy()
    rmSync(dir, { recursive: true, force: true })
  })

  const bucket = 'test-bucket'
  const versions = new Map()
  function put(bucket, key, body) {
    const bytes = Buffer.from(body)
    const uri = `s3://${bucket}/${key}`
    const digest = sha256(bytes)
    const found = versions.get(uri)
    if (found) assert.equal(found.sha256, digest)
    const ref = { uri, versionId: digest, sha256: digest, size: bytes.length }
    versions.set(uri, { ...ref, bytes })
    return ref
  }
  const s3 = { async send({ input }) {
    if (input.Body) return { VersionId: put(input.Bucket, input.Key, input.Body).versionId }
    const found = versions.get(`s3://${input.Bucket}/${input.Key}`)
    assert.equal(input.VersionId, found?.versionId)
    return { VersionId: found.versionId, ContentLength: found.bytes.length,
      Body: { transformToByteArray: async () => found.bytes } }
  } }
  const objects = {
    async putIfAbsent(key, bytes) { return put(bucket, key, bytes) },
    async read({ size, ...ref }) { return pinnedReader(s3, bucket)(ref, ref.uri.split('/')[3]) }
  }
  const readPinned = pinnedReader(s3, bucket)
  const identity = pipelineIdentity()
  const resolveServiceActor = (token, id) => identity.resolve(token, id) ?? resolveRunnerServiceActor(token)
  const server = bootstrap({
    config: { mode: 'local', ddbTable: table, dynamoEndpoint: endpoint, objectDirectory: dir, host: '127.0.0.1', port: 1 },
    identity: createDemoIdentity(), documentClient: document, objects, internalActor: identity.resolve, workers: {
      ...checkerPolicies, resolveServiceActor, canServiceAccessRequest: (token, id) => Boolean(resolveServiceActor(token, id)),
      compilationArtifacts: compilationArtifacts(readPinned)
    }
  })
  t.after(() => server.close())
  const intake = createStore({ table: intakeTable, bucket: 'test-intake', db: document, s3, pipeline: true })
  const baselineHash = sha256('synthetic baseline')
  const registryFile = join(dir, 'registry.json')
  writeFileSync(registryFile, JSON.stringify({ demo: baselineHash }))
  const app = await createIntakeApp({
    env: { INTAKE_TABLE: intakeTable, INTAKE_BUCKET: 'test-intake', INTAKE_REGISTRY: registryFile,
      COGNITO_HOSTED_URL: 'https://synthetic.example', COGNITO_REDIRECT_URI: 'http://localhost:8080',
      INTAKE_SCREENING_ENABLED: 'true', BEDROCK_MODEL_ID: 'recorded', BEDROCK_GUARDRAIL_ID: 'test', BEDROCK_GUARDRAIL_VERSION: '1' },
    tokenVerifier: { async verify(token) { return { sub: token } } },
    integrated: { ...pipelineHttp({ store: intake, server, readPinned }), store: intake,
      async roles(subject) { return ['demo-po', 'other-po'].includes(subject) ? ['PO'] : ['clinician'] },
      async screen(input) { return { result: { decision: 'pass', summary: 'Synthetic request is complete.',
        issues: [], suggestions: [], evidence: [{ source: input.requirementsSource, location: 'Request' }] } } }
    }
  })
  await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => app.server.close(resolve)))
  const origin = `http://127.0.0.1:${app.server.address().port}`
  const call = (path, body, actor = 'demo-po', key) => fetch(origin + path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${actor}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body && JSON.stringify(body)
  })
  const ok = async response => {
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  const golden = put(bucket, 'sources/cases.json', readFileSync(fixture('golden-cases.json')))
  const guideline = put(bucket, 'sources/guideline.md', readFileSync(fixture('guideline.md')))
  const catalog = evidenceCatalog([{ pathway: 'Child cough', baselineVersion: 'demo', baselineHash, guideline, goldenCases: golden }])
  const recorded = practiceClient([fileURLToPath(new URL('../../drafter/test/fixtures/recorded/good.json', import.meta.url))])
  const drafter = { ...recorded, async invoke(...args) {
    const result = await recorded.invoke(...args)
    // A synthetic, fully specified scenario with the fixture's open questions already resolved.
    return { ...result, output: { ...result.output, ambiguities: [] } }
  } }
  const readJob = async (jobId, sk = 'META') => (await document.send(new GetCommand({
    TableName: table, Key: { pk: `JOB#${jobId}`, sk }, ConsistentRead: true
  }))).Item
  let duringDispatch
  const makeWorker = () => createPipeline({
    intake, review: app.review, screening: app.screening, registry: app.registry, catalog, drafter,
    async readPinned(ref, prefix) {
      if (duringDispatch && ref.uri === guideline.uri) {
        const race = duringDispatch
        duringDispatch = undefined
        await race()
      }
      return readPinned(ref, prefix)
    },
    server, identity, runnerRecord: readJob, log: event => { if (event.reason) t.diagnostic(JSON.stringify(event)) }
  })
  let pipeline = makeWorker()
  const submission = { goal: 'Apply the resolved synthetic fixture', pathway: 'Child cough', targetUsers: 'Synthetic users',
    acceptanceCriteria: 'Match the curated golden cases.', baselineVersion: 'demo', guidelineUrls: [] }
  const key = randomUUID()
  const revision = await ok(await call('/api/requests', submission, 'demo-po', key))
  assert.equal((await ok(await call('/api/requests', submission, 'demo-po', key))).revisionId, revision.revisionId)
  const base = `/api/requests/${revision.requestId}/revisions/${revision.revisionId}`
  assert.equal((await call(`${base}/workflow/download`)).status, 404)
  assert.equal((await call(`${base}/workflow`, undefined, 'other-po')).status, 404)
  await pipeline.tick()
  const preview = await ok(await call(`${base}/screening`))
  assert.ok(preview.preview)
  const confirmation = { previewId: preview.preview.id, previewHash: preview.preview.hash, attemptId: preview.attemptId, feedback: '' }
  assert.equal((await ok(await call(`${base}/confirmation`, confirmation))).confirmed, true)
  assert.equal((await ok(await call(`${base}/confirmation`, confirmation))).confirmed, true)
  await pipeline.tick() // Durable acceptance.
  assert.equal((await intake.work('dispatch', revision.revisionId)).stage, 'create')
  pipeline = makeWorker() // Restart after acceptance and before creating the workflow.
  async function reach(status, target = { row: revision, path: base }) {
    for (let i = 0; i < 35; i++) {
      await pipeline.tick()
      const progress = await ok(await call(`${target.path}/workflow`))
      if (progress?.status === status) return
      const work = await intake.work('dispatch', target.row.revisionId)
      assert.notEqual(work.stage, 'blocked', JSON.stringify({ status, progress, reason: work.reason }))
      await delay(1100)
    }
    assert.fail(`Did not reach ${status}; work=${JSON.stringify(await intake.work('dispatch', target.row.revisionId))}`)
  }
  await reach('WAITING_FOR_CLINICAL_APPROVAL')
  const id = (await intake.work('dispatch', revision.revisionId)).workflowId
  const workflow = `/api/workflow/requests/${id}`
  const decision = async (category, actor, path) => {
    const queue = await ok(await call(`/api/workflow/reviews/queue?category=${category}`, undefined, actor))
    const item = queue.items.find(item => item.requestId === id)
    assert.ok(item)
    const context = await ok(await call(`${workflow}/review-context?category=${category}&expectedVersion=${item.workflowVersion}`, undefined, actor))
    const body = { ...context.decisionReferences, eventId: randomUUID(), decision: 'APPROVE' }
    assert.equal((await call(`${workflow}/${path}`, { ...body, eventId: randomUUID() }, 'demo-po-clinician')).status, 403)
    assert.equal((await call(`${workflow}/${path}`, { ...body, eventId: randomUUID(), expectedVersion: body.expectedVersion - 1 }, actor)).status, 409)
    if (category === 'RELEASE') {
      const evidence = await ok(await call(`${workflow}/verification-report?expectedVersion=${item.workflowVersion}`, undefined, actor))
      assert.equal(evidence.coverageComplete, true)
    }
    await ok(await call(`${workflow}/${path}`, body, actor))
  }
  await decision('CLINICAL', 'demo-clinician', 'clinical-decisions')
  await reach('COMPILING')
  const config = new Harness(document).config({
    table, bucket, workerId: 'cht-runner', workRoot: dir,
    ...(liveContainers ? { compileImage: process.env.COMPILE_IMAGE,
      buildImage: process.env.BUILD_IMAGE, compilerDir: process.env.COMPILER_DIR, templateDir: process.env.TEMPLATE_DIR,
      verifierDir: process.env.VERIFIER_DIR, verifierCommit: process.env.VERIFIER_COMMIT } : {})
  })
  const fake = new FakeStages()
  fake.compile = async input => {
    const path = 'forms/app/f.xlsx'
    const form = Buffer.from('test form')
    const hash = sha256(form)
    mkdirSync(join(input.outDir, 'forms/app'), { recursive: true })
    writeFileSync(join(input.outDir, path), form)
    writeFileSync(join(input.outDir, 'compile-manifest.json'), JSON.stringify({ manifestVersion: 1, formId: 'f',
      snapshotHash: input.snapshotHash, inputHash: sha256(readFileSync(join(input.inDir, 'logic.json'))),
      artifactHash: sha256(`${path}\t${hash}\n`), template: { hash: sha256('template') },
      files: [{ path, sha256: hash, bytes: form.length }] }))
    return OK
  }
  const worker = new Worker({ config, queue: new FakeQueue(), store: new JobStore(document, table),
    artifacts: { async get(uri) { return versions.get(uri).bytes }, async put(key, bytes) { return put(bucket, key, bytes) } },
    stages: liveContainers ? dockerStages : fake
  })
  async function run(jobId) {
    const { payload } = await readJob(jobId, 'OUTBOX')
    const outcome = await worker.handle({ messageId: jobId, receiptHandle: jobId, receiveCount: 1, body: JSON.stringify(payload) })
    const result = await readJob(jobId)
    assert.equal(outcome, 'SUCCEEDED', JSON.stringify({ outcome, code: result.errorCode, message: result.errorMessage,
      retry: result.lastErrorMessage }))
    return { payload, result }
  }
  const compiled = await run((await server.automation.store.getWorkflow(id)).compilationId)
  await reach('VERIFYING')
  const verificationId = (await server.automation.store.getWorkflow(id)).verificationId
  const { payload } = await readJob(verificationId, 'OUTBOX')
  assert.equal(payload.goldenCasesHash, `sha256:${golden.sha256}`)
  fake.report = fictionalReport({ compileArtifactHash: compiled.result.compileArtifactHash, goldenCasesHash: golden.sha256,
    references: { logicModelHash: payload.logicModelHash.replace('sha256:', ''), clinicalApprovalId: payload.clinicalApprovalId,
      compilationJobId: payload.compileJobId, packageHash: payload.packageHash.replace('sha256:', '') } })
  await run(verificationId)
  await reach('WAITING_FOR_RELEASE_APPROVAL')
  assert.equal((await call(`${base}/workflow/download`)).status, 404)
  await decision('RELEASE', 'demo-release', 'release-decisions')
  await reach('RELEASE_APPROVED')
  const response = await call(`${base}/workflow/download`)
  assert.equal(response.status, 200)
  assert.equal(sha256(Buffer.from(await response.arrayBuffer())), compiled.result.packageHash)
  assert.equal((await server.automation.store.listCompilationJobs(id)).length, 1)
  assert.equal((await server.automation.store.listVerifyBuildJobs(id)).length, 1)

  if (liveContainers) return
  async function confirmedRequest(overrides) {
    const row = await ok(await call('/api/requests', { ...submission, ...overrides }, 'demo-po', randomUUID()))
    const path = `/api/requests/${row.requestId}/revisions/${row.revisionId}`
    await pipeline.tick()
    const screen = await ok(await call(`${path}/screening`))
    await ok(await call(`${path}/confirmation`, { previewId: screen.preview.id, previewHash: screen.preview.hash,
      attemptId: screen.attemptId, feedback: '' }))
    return { row, path }
  }
  const missing = await confirmedRequest({ pathway: 'Unconfigured pathway' })
  await pipeline.tick()
  assert.equal((await intake.work('dispatch', missing.row.revisionId)).reason, 'EVIDENCE_BUNDLE_MISSING')
  assert.equal((await call(`${missing.path}/workflow/download`)).status, 404)

  catalog.set(JSON.stringify(['tampered evidence', 'demo']),
    { baselineHash, guideline, goldenCases: { ...golden, sha256: sha256('incorrect digest') } })
  const tampered = await confirmedRequest({ pathway: 'Tampered evidence' })
  await pipeline.tick()
  assert.equal((await intake.work('dispatch', tampered.row.revisionId)).reason, 'OBJECT_HASH_MISMATCH')

  const superseded = await confirmedRequest({ goal: 'Before the correction' })
  duringDispatch = async () => {
    await ok(await call(`/api/requests/${superseded.row.requestId}`, { ...submission, goal: 'After the correction' },
      'demo-po', randomUUID()))
  }
  await pipeline.tick()
  assert.equal((await intake.work('dispatch', superseded.row.revisionId)).stage, 'dispatch')
  await delay(2200)
  await pipeline.tick()
  const old = await intake.work('dispatch', superseded.row.revisionId)
  assert.equal(old.stage, 'superseded')
  assert.equal(old.workflowId, undefined)

  const wrongCases = JSON.parse(readFileSync(fixture('golden-cases.json')))
  wrongCases[0].expected.classification = 'wrong-test-expected-outcome'
  catalog.set(JSON.stringify(['failed checker', 'demo']), {
    baselineHash, guideline, goldenCases: put(bucket, 'sources/wrong-cases.json', JSON.stringify(wrongCases))
  })
  const rejected = await confirmedRequest({ pathway: 'Failed checker' })
  await reach('FAILED', rejected)
  assert.equal((await ok(await call(`${rejected.path}/workflow`))).stoppedAt, 'WAITING_FOR_LOGIC_CHECKS')
  const rejectedRun = await intake.work('dispatch', rejected.row.revisionId)
  assert.equal((await server.automation.store.listCompilationJobs(rejectedRun.workflowId)).length, 0)
  assert.equal((await call(`${rejected.path}/workflow/download`)).status, 404)
})
