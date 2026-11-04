import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'node:crypto'
import { hash, HttpError } from './intake.js'
import { awsCredentials } from './credentials.js'

export function createStore({ table, bucket,
  db = DynamoDBDocumentClient.from(new DynamoDBClient({ credentials: awsCredentials })),
  s3 = new S3Client({ credentials: awsCredentials }) }) {
  const read = async Key => (await db.send(new GetCommand({ TableName: table, Key, ConsistentRead: true }))).Item
  const reservationKey = (author, key) => ({ pk: `author#${author}`, sk: `key#${key}` })
  const requestPartition = author => `requests#${author}`

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
