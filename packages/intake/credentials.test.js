import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

test('role checks recover after credentials are created without restarting the server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-credentials-'))
  // Isolate AWS configuration and SDK file caches from other tests and real profiles.
  const env = { ...process.env,
    AWS_PROFILE: 'intake-recovery-test', AWS_REGION: 'us-west-2',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_CONFIG_FILE: join(directory, 'config'),
    AWS_SHARED_CREDENTIALS_FILE: join(directory, 'credentials')
  }
  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN']) delete env[key]

  const script = `
    import assert from 'node:assert/strict'
    import { writeFile } from 'node:fs/promises'
    import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
    import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
    import { awsCredentials } from './credentials.js'
    import { authenticate } from './intake.js'
    import { createStore } from './storage.js'

    let signedRequests = 0
    const client = new DynamoDBClient({
      credentials: awsCredentials,
      requestHandler: { async handle(request) {
        assert.ok(request.headers.authorization.includes('Credential=TESTONLY/'))
        signedRequests++
        return { response: { statusCode: 200, headers: {},
          body: Buffer.from(JSON.stringify({ Item: { roles: { L: [{ S: 'PO' }] } } })) } }
      } }
    })
    const store = createStore({ table: 'test', bucket: 'test',
      db: DynamoDBDocumentClient.from(client), s3: {} })
    const verify = async () => ({ sub: 'alice' })
    const login = () => authenticate('Bearer valid', verify, store.roles)

    try {
      await assert.rejects(login(), { name: 'CredentialsProviderError' })
      await assert.rejects(login(), { name: 'CredentialsProviderError' })
      assert.equal(signedRequests, 0)
      await writeFile(process.env.AWS_SHARED_CREDENTIALS_FILE,
        '[intake-recovery-test]\\naws_access_key_id = TESTONLY\\naws_secret_access_key = TESTONLY\\n')
      assert.deepEqual(await Promise.all([login(), login()]), ['alice', 'alice'])
      assert.equal(await login(), 'alice')
      assert.equal(signedRequests, 3)
    } finally {
      client.destroy()
    }
  `
  try {
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('.', import.meta.url), env, timeout: 15000
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
