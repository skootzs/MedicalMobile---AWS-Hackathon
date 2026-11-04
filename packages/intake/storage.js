import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { hash } from './intake.js'

export function createStore({ table, bucket }) {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  const s3 = new S3Client({})
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
    async finish(author, key, snapshot) {
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
            { Put: { TableName: table, Item: { ...revision, snapshot }, ConditionExpression: 'attribute_not_exists(pk)' } }
          ] }))
          return snapshot
        } catch (error) {
          const existing = await read(index)
          if (existing?.result) return existing.result
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
