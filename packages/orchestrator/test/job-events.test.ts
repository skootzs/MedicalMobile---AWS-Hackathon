import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJobEventBody, pollJobEventsOnce, runnerPrincipalForJob } from '../src/job-events.ts';

test('parses a Pipe body whose attempt is a numeric string', () => {
  const event = parseJobEventBody('{"requestId":"req-1","jobId":"compile-1","status":"SUCCEEDED","attempt":"2"}');
  assert.deepEqual(event, { requestId: 'req-1', jobId: 'compile-1', status: 'SUCCEEDED', attempt: '2', jobType: undefined });
});

test('drops a body with no job id or a padded attempt', () => {
  assert.equal(parseJobEventBody('{"attempt":"1"}'), null);
  assert.equal(parseJobEventBody('{"jobId":"compile-1","attempt":"01"}'), null);
  assert.equal(parseJobEventBody('not json'), null);
});

test('reconciles a compile event as the compile runner and deletes the message', async () => {
  const sent = [];
  const seen = [];
  const handled = await pollJobEventsOnce({
    queueUrl: 'https://example.invalid/job-events',
    sqs: { async send(command) { sent.push(command); return sent.length === 1 ? { Messages: [{ Body: '{"jobId":"compile-1","status":"SUCCEEDED","attempt":"1"}', ReceiptHandle: 'h1', MessageId: 'm1' }] } : {}; } },
    reconciler: { async reconcile(notification, principal) { seen.push({ notification, principal }); return { status: 'RECONCILED' }; } },
    async jobType() { return 'COMPILE_LOGIC'; },
  });
  assert.equal(handled, 1);
  assert.equal(seen[0].principal.actorId, 'cht-runner-compile');
  assert.equal(seen[0].notification.attempt, '1');
  assert.equal(sent.length, 2);
});

test('picks a different runner principal for compile and verify', () => {
  assert.equal(runnerPrincipalForJob('COMPILE_LOGIC')?.actorId, 'cht-runner-compile');
  assert.equal(runnerPrincipalForJob('VERIFY_BUILD')?.actorId, 'cht-runner-verify');
  assert.equal(runnerPrincipalForJob('DRAFT_LOGIC'), null);
});
