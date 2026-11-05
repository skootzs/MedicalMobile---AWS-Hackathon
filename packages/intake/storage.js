import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'node:crypto'
import { hash, HttpError } from './intake.js'
import { awsCredentials } from './credentials.js'

export function createStore({ table, bucket, pipeline = false,
  db = DynamoDBDocumentClient.from(new DynamoDBClient({ credentials: awsCredentials })),
  s3 = new S3Client({ credentials: awsCredentials }) }) {
  const read = async Key => (await db.send(new GetCommand({ TableName: table, Key, ConsistentRead: true }))).Item
  const reservationKey = (author, key) => ({ pk: `author#${author}`, sk: `key#${key}` })
  const requestPartition = author => `requests#${author}`

  const workKey = (kind, revisionId) => ({ pk: 'pipeline', sk: `${kind}#${revisionId}` })
  const enqueue = (kind, author, requestId, revisionId) => ({ Put: {
    TableName: table, Item: { ...workKey(kind, revisionId), kind, author, requestId, revisionId,
      stage: kind, pipelineQueue: 'pending', attempts: 0, due: Date.now(), queuedAt: Date.now() },
    ConditionExpression: 'attribute_not_exists(pk)'
  } })
  const leaseCondition = 'lease = :lease AND due > :now'
  const conditionalFailure = error => error.name === 'ConditionalCheckFailedException' ||
    error.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')

  async function query(pk, prefix) {
    const items = []
    let cursor
    do {
      const page = await db.send(new QueryCommand({
        TableName: table, ConsistentRead: true,
        KeyConditionExpression: prefix ? 'pk = :pk AND begins_with(sk, :prefix)' : 'pk = :pk',
        ExpressionAttributeValues: prefix ? { ':pk': pk, ':prefix': prefix } : { ':pk': pk },
        ExclusiveStartKey: cursor
      }))
      items.push(...page.Items.map(item => item.snapshot))
      cursor = page.LastEvaluatedKey
    } while (cursor)
    return items
  }

  return {
    current: async (author, requestId, revisionId) =>
      (await read({ pk: `author#${author}`, sk: `head#${requestId}` }))?.revisionId === revisionId,
    work: (kind, revisionId) => read(workKey(kind, revisionId)),
    async *dueWork(now) {
      let cursor
      do {
        const page = await db.send(new QueryCommand({
          TableName: table, IndexName: 'pipeline-due', Limit: 100, ExclusiveStartKey: cursor,
          KeyConditionExpression: 'pipelineQueue = :queue AND due <= :now',
          ExpressionAttributeValues: { ':queue': 'pending', ':now': now }
        }))
        yield* page.Items ?? []
        cursor = page.LastEvaluatedKey
      } while (cursor)
    },
    async claimWork(item, now) {
      try {
        const result = await db.send(new UpdateCommand({
          TableName: table, Key: workKey(item.kind, item.revisionId),
          ConditionExpression: 'due <= :now', UpdateExpression: 'SET lease = :lease, due = :until',
          ExpressionAttributeValues: { ':now': now, ':lease': randomUUID(), ':until': now + 10 * 60_000 },
          ReturnValues: 'ALL_NEW'
        }))
        return result.Attributes
      } catch (error) {
        if (!conditionalFailure(error)) throw error
      }
    },
    async saveWork(item, fields, guard) {
      const Key = workKey(item.kind, item.revisionId)
      const next = { ...item, ...fields }
      delete next.lease
      if (fields.due === null) {
        delete next.due
        delete next.pipelineQueue
      }
      const put = { TableName: table, Item: next, ConditionExpression: leaseCondition,
        ExpressionAttributeValues: { ':lease': item.lease, ':now': Date.now() } }
      try {
        if (!guard) {
          await db.send(new PutCommand(put))
          return true
        }
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Put: put },
          { ConditionCheck: { TableName: table, Key: { pk: `author#${item.author}`, sk: `head#${item.requestId}` },
            ConditionExpression: 'revisionId = :revision', ExpressionAttributeValues: { ':revision': item.revisionId } } },
          { ConditionCheck: { TableName: table, Key: { pk: `author#${item.author}`, sk: `phase#${item.requestId}#${item.revisionId}` },
            ConditionExpression: '#v = :version AND policy = :policy',
            ExpressionAttributeNames: { '#v': 'version' },
            ExpressionAttributeValues: { ':version': guard.version, ':policy': guard.policy } } }
        ] }))
        return true
      } catch (error) {
        if (conditionalFailure(error)) return false
        throw error
      }
    },
    async readSource(source) {
      if (source.bucket !== bucket || !source.key.startsWith('intake/') || !source.versionId) throw new Error('Invalid source reference.')
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: source.key, VersionId: source.versionId }))
      return Buffer.from(await object.Body.transformToByteArray())
    },
    phase: (author, requestId, revisionId) => read({ pk: `author#${author}`, sk: `phase#${requestId}#${revisionId}` }),
    async savePhase(author, requestId, revisionId, previous, next, event, requireCurrent = false) {
      const Key = { pk: `author#${author}`, sk: `phase#${requestId}#${revisionId}` }
      // Phase-one deployments predate the head pointer. Initialize it once without
      // overwriting a pointer committed concurrently by a new submission.
      const headKey = { pk: Key.pk, sk: `head#${requestId}` }
      if (requireCurrent && !await read(headKey)) {
        const history = await query(requestPartition(author), `${requestId}#`)
        history.sort((a, b) => b.events[0].at.localeCompare(a.events[0].at) || b.revisionId.localeCompare(a.revisionId))
        if (!history.length) return null
        try {
          await db.send(new PutCommand({ TableName: table, Item: { ...headKey, revisionId: history[0].revisionId },
            ConditionExpression: 'attribute_not_exists(pk)' }))
        } catch (error) {
          if (error.name !== 'ConditionalCheckFailedException') throw error
        }
      }
      const version = (previous?.version ?? 0) + 1
      const conditions = requireCurrent ? [{ ConditionCheck: {
        TableName: table, Key: headKey,
        ConditionExpression: 'revisionId = :revision', ExpressionAttributeValues: { ':revision': revisionId }
      } }] : []
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          ...conditions,
          ...(pipeline && next.outbox && !previous?.outbox ? [enqueue('dispatch', author, requestId, revisionId)] : []),
          { Put: { TableName: table, Item: { ...Key, ...next, version },
            ConditionExpression: previous ? '#v = :v' : 'attribute_not_exists(pk)',
            ...(previous && { ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': previous.version } }) } },
          { Put: { TableName: table, Item: { pk: Key.pk, sk: `event#${requestId}#${revisionId}#${randomUUID()}`,
            ...event, at: new Date().toISOString() }, ConditionExpression: 'attribute_not_exists(pk)' } }
        ] }))
        return { ...next, version }
      } catch (error) {
        if (error.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')) return null
        throw error
      }
    },
    async roles(author) {
      return (await read({ pk: `roles#${author}`, sk: 'assignment' }))?.roles ?? []
    },
    async reserve(author, key, proposed) {
      const index = reservationKey(author, key)
      try {
        await db.send(new PutCommand({
          TableName: table, Item: { ...index, ...proposed },
          ConditionExpression: 'attribute_not_exists(pk)'
        }))
        return proposed
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error
        return read(index)
      }
    },
    async source(key, bytes) {
      const digest = hash(bytes)
      const object = { Bucket: bucket, Key: key }
      let versionId
      for (let attempt = 0; attempt < 4 && !versionId; attempt++) {
        try {
          const result = await s3.send(new PutObjectCommand({
            ...object, Body: bytes, IfNoneMatch: '*',
            ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
            Metadata: { sha256: digest }
          }))
          versionId = result.VersionId
        } catch (error) {
          const status = error.$metadata?.httpStatusCode
          if (status === 409) continue
          if (status !== 412) throw error
          const existing = await s3.send(new HeadObjectCommand(object))
          if (existing.Metadata?.sha256 !== digest) throw new Error('Reserved source checksum mismatch.')
          versionId = existing.VersionId
        }
      }
      if (!versionId || versionId === 'null') throw new Error('Source storage requires S3 versioning.')
      return { bucket, key, versionId, sha256: digest }
    },
    async finish(author, key, snapshot, commitGuard) {
      const index = reservationKey(author, key)
      const revision = { pk: requestPartition(author), sk: `${snapshot.requestId}#${snapshot.revisionId}` }
      for (let attempt = 0; ; attempt++) {
        try {
          await db.send(new TransactWriteCommand({ TransactItems: [
            { Update: {
              TableName: table, Key: index, UpdateExpression: 'SET #result = :result',
              ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#result)',
              ExpressionAttributeNames: { '#result': 'result' },
              ExpressionAttributeValues: { ':result': snapshot }
            } },
            { Put: { TableName: table, Item: { ...revision, snapshot }, ConditionExpression: 'attribute_not_exists(pk)' } },
            { Put: { TableName: table, Item: { pk: `author#${author}`, sk: `head#${snapshot.requestId}`, revisionId: snapshot.revisionId },
              ...(commitGuard && { ConditionExpression: 'revisionId = :expected', ExpressionAttributeValues: { ':expected': commitGuard.revisionId } }) } },
            ...(pipeline && snapshot.screeningStatus === 'pending_screening' ?
              [enqueue('screen', author, snapshot.requestId, snapshot.revisionId)] : []),
            ...(commitGuard ? [{ ConditionCheck: { TableName: table,
              Key: { pk: `author#${author}`, sk: `phase#${snapshot.requestId}#${commitGuard.revisionId}` },
              ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' },
              ExpressionAttributeValues: { ':v': commitGuard.phaseVersion } } }] : [])
          ] }))
          return snapshot
        } catch (error) {
          const existing = await read(index)
          if (existing?.result) return existing.result
          if (commitGuard && error.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')) {
            throw new HttpError(409, 'The request or screening changed. Refresh before submitting revised text.')
          }
          const conflict = error.CancellationReasons?.some(reason => reason.Code === 'TransactionConflict')
          if (!conflict || attempt >= 5) throw error
          await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt))
        }
      }
    },
    list: author => query(requestPartition(author), ''),
    history: (author, requestId) => query(requestPartition(author), `${requestId}#`),
    async revision(author, requestId, revisionId) {
      return (await read({ pk: requestPartition(author), sk: `${requestId}#${revisionId}` }))?.snapshot
    }
  }
}
