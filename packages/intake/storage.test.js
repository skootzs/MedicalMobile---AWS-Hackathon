import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from './storage.js'

test('phase commit atomically checks revision head, state version, and appends audit evidence', async () => {
  const commands = []
  const db = { async send(command) {
    commands.push(command.input)
    if (command.constructor.name === 'GetCommand') return { Item: { revisionId: 'revision' } }
    return {}
  } }
  const store = createStore({ table: 'table', bucket: 'bucket', db, s3: {} })
  const saved = await store.savePhase('alice', 'request', 'revision', { version: 3 }, { status: 'screening_passed' }, { type: 'completed' }, true)
  assert.equal(saved.version, 4)
  const transaction = commands.at(-1).TransactItems
  assert.equal(transaction.length, 3)
  assert.deepEqual(transaction[0].ConditionCheck.ExpressionAttributeValues, { ':revision': 'revision' })
  assert.equal(transaction[1].Put.ConditionExpression, '#v = :v')
  assert.equal(transaction[1].Put.ExpressionAttributeValues[':v'], 3)
  assert.equal(transaction[2].Put.Item.type, 'completed')
  assert.equal(transaction[2].Put.ConditionExpression, 'attribute_not_exists(pk)')
})

test('legacy revision head initializes from latest history with a conditional write', async () => {
  const commands = []
  const db = { async send(command) {
    commands.push(command.input)
    if (command.constructor.name === 'GetCommand') return {}
    if (command.constructor.name === 'QueryCommand') return { Items: [
      { snapshot: { revisionId: 'old', events: [{ at: '2026-11-01' }] } },
      { snapshot: { revisionId: 'new', events: [{ at: '2026-11-02' }] } }
    ] }
    return {}
  } }
  await createStore({ table: 'table', bucket: 'bucket', db, s3: {} })
    .savePhase('alice', 'request', 'new', undefined, { status: 'screening' }, { type: 'started' }, true)
  const head = commands.find(command => command.Item)
  assert.equal(head.Item.revisionId, 'new')
  assert.equal(head.ConditionExpression, 'attribute_not_exists(pk)')
})

test('source reads use the recorded object version and reject foreign bucket references', async () => {
  let command
  const store = createStore({ table: 'table', bucket: 'private', db: {}, s3: { async send(value) {
    command = value.input
    return { Body: { async transformToByteArray() { return Buffer.from('evidence') } } }
  } } })
  const source = { bucket: 'private', key: 'intake/revision/attachment', versionId: 'exact-version' }
  assert.equal((await store.readSource(source)).toString(), 'evidence')
  assert.equal(command.VersionId, 'exact-version')
  await assert.rejects(store.readSource({ ...source, bucket: 'foreign' }))
})


test('suggested revision commits atomically require the current revision and exact screening state', async () => {
  const commands = []
  const store = createStore({ table: 'table', bucket: 'bucket', s3: {}, db: { async send(command) {
    commands.push(command.input)
    return {}
  } } })
  const snapshot = { requestId: 'request', revisionId: 'new' }
  await store.finish('alice', 'key', snapshot, { revisionId: 'old', phaseVersion: 4 })
  const transaction = commands[0].TransactItems
  assert.equal(transaction.length, 4)
  assert.equal(transaction[2].Put.ConditionExpression, 'revisionId = :expected')
  assert.equal(transaction[2].Put.ExpressionAttributeValues[':expected'], 'old')
  assert.equal(transaction[3].ConditionCheck.ExpressionAttributeValues[':v'], 4)
  assert.match(transaction[3].ConditionCheck.Key.sk, /phase#request#old/)
})

test('a concurrent correction or screening change prevents a suggested revision from committing', async () => {
  const store = createStore({ table: 'table', bucket: 'bucket', s3: {}, db: { async send(command) {
    if (command.constructor.name === 'GetCommand') return { Item: {} }
    throw Object.assign(new Error('Conflict'), { CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] })
  } } })
  await assert.rejects(store.finish('alice', 'key', { requestId: 'request', revisionId: 'new' }, { revisionId: 'old', phaseVersion: 4 }), { status: 409 })
})
