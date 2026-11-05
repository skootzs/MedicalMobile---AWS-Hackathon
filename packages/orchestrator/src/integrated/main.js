import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import { SQSClient } from '@aws-sdk/client-sqs'
import { createIntakeApp } from '../../../intake/server.js'
import { createStore } from '../../../intake/storage.js'
import { liveClient, liveConfigFromEnv } from '../../../drafter/src/bedrock.ts'
import { bootstrap } from '../bootstrap.ts'
import { loadConfig } from '../config.ts'
import { pollJobEventsOnce } from '../job-events.ts'
import { resolveRunnerServiceActor } from '../service-actors.ts'
import { compilationArtifacts, pinnedReader } from './artifacts.js'
import { pipelineHttp } from './http.js'
import { checkerPolicies, createPipeline, evidenceCatalog, pipelineIdentity } from './pipeline.js'

const env = process.env
const config = loadConfig(env)
if (config.mode !== 'aws' || !env.INTAKE_TABLE || !env.INTAKE_BUCKET || !env.PIPELINE_EVIDENCE_CATALOG ||
    !env.JOB_EVENTS_QUEUE_URL || env.INTAKE_SCREENING_ENABLED !== 'true') {
  throw new Error('Configure AWS mode, intake storage and screening, job events, and the pipeline evidence catalog.')
}
const catalog = evidenceCatalog(JSON.parse(await readFile(env.PIPELINE_EVIDENCE_CATALOG, 'utf8')))
const document = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }))
const s3 = new S3Client({ region: config.region })
const sqs = new SQSClient({ region: config.region })
const intake = createStore({ table: env.INTAKE_TABLE, bucket: env.INTAKE_BUCKET, db: document, s3, pipeline: true })
const readPinned = pinnedReader(s3, config.artifactBucket)
const identity = pipelineIdentity()
const resolveServiceActor = (token, id) => identity.resolve(token, id) ?? resolveRunnerServiceActor(token)
const server = bootstrap({ config, documentClient: document, internalActor: identity.resolve, workers: {
  ...checkerPolicies, compilationArtifacts: compilationArtifacts(readPinned),
  resolveServiceActor, canServiceAccessRequest: (token, id) => Boolean(resolveServiceActor(token, id))
} })
const app = await createIntakeApp({ integrated: {
  ...pipelineHttp({ store: intake, server, readPinned }), store: intake,
  async roles(subject, claims) {
    const groups = Array.isArray(claims['cognito:groups']) ? claims['cognito:groups'] : []
    const reviewers = { clinician: 'clinician', release_approver: 'release approver', service_designer: 'service designer' }
    const roles = groups.filter(group => Object.hasOwn(reviewers, group)).map(group => reviewers[group])
    if (groups.includes('po') && (await intake.roles(subject)).includes('PO')) roles.push('PO')
    return roles
  }
} })
const drafter = await liveClient(liveConfigFromEnv({ ...env,
  BEDROCK_TIMEOUT_MS: String(app.screening.timeoutMs),
  GUARDRAIL_ID: env.BEDROCK_GUARDRAIL_ID, GUARDRAIL_VERSION: env.BEDROCK_GUARDRAIL_VERSION
}))
const runnerRecord = async jobId => (await document.send(new GetCommand({
  TableName: config.ddbTable, Key: { pk: `JOB#${jobId}`, sk: 'META' }, ConsistentRead: true
}))).Item
const log = event => console.log(JSON.stringify(event))
const pipeline = createPipeline({
  intake, review: app.review, screening: app.screening, registry: app.registry,
  catalog, readPinned, drafter, server, identity, runnerRecord, log
})

let stopped = false
async function poll(name, task, interval) {
  while (!stopped) {
    try { await task() } catch (error) { log({ worker: name, error: error.name }) }
    if (!stopped) await delay(interval)
  }
}
app.listen()
const workers = [
  poll('pipeline', () => pipeline.tick(), 1500),
  poll('job-events', () => pollJobEventsOnce({
    queueUrl: env.JOB_EVENTS_QUEUE_URL, sqs, reconciler: server.services.reconciler,
    jobType: async jobId => (await runnerRecord(jobId))?.jobType ?? null,
    log: (event, detail) => log({ event, detail })
  }), 1000)
]
async function shutdown() {
  if (stopped) return
  stopped = true
  app.server.close()
  await Promise.all(workers)
  await server.close()
  sqs.destroy()
  s3.destroy()
  document.destroy()
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
