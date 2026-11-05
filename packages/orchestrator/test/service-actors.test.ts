import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunnerServiceActor, runnerPrincipal, RUNNER_COMPILE_ACTOR_ID, RUNNER_VERIFY_ACTOR_ID } from '../src/service-actors.ts';

test('maps the two runner actor ids to COMPILER and VERIFIER', () => {
  const compile = resolveRunnerServiceActor(runnerPrincipal(RUNNER_COMPILE_ACTOR_ID));
  const verify = resolveRunnerServiceActor(runnerPrincipal(RUNNER_VERIFY_ACTOR_ID));
  assert.deepEqual(compile, { id: 'cht-runner-compile', roles: ['COMPILER'] });
  assert.deepEqual(verify, { id: 'cht-runner-verify', roles: ['VERIFIER'] });
  assert.notEqual(compile?.id, verify?.id);
});

test('rejects a human principal and an unknown runner id', () => {
  assert.equal(resolveRunnerServiceActor('svc-compiler'), null);
  assert.equal(resolveRunnerServiceActor({ service: 'r7-runner', actorId: 'someone-else' }), null);
  assert.equal(resolveRunnerServiceActor({ service: 'other', actorId: RUNNER_COMPILE_ACTOR_ID }), null);
});
