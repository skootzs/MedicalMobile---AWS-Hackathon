/**
 * The two R7 runner identities. install-runner.sh sets WORKER_ID=cht-runner, and
 * the runner records runnerActorId as cht-runner-compile or cht-runner-verify.
 * Those are different actors, so a compiler cannot approve its own build.
 */
import type { Actor } from './workflow.ts';

export const RUNNER_COMPILE_ACTOR_ID = 'cht-runner-compile';
export const RUNNER_VERIFY_ACTOR_ID = 'cht-runner-verify';

export interface RunnerServicePrincipal {
  readonly service: 'r7-runner';
  readonly actorId: string;
}

export function runnerPrincipal(actorId: string): RunnerServicePrincipal {
  return { service: 'r7-runner', actorId };
}

/** Map a job-events consumer principal to the COMPILER or VERIFIER actor. Anything else is not a runner. */
export function resolveRunnerServiceActor(principal: unknown): Actor | null {
  if (!principal || typeof principal !== 'object') return null;
  const actorId = (principal as { service?: unknown; actorId?: unknown }).actorId;
  const service = (principal as { service?: unknown }).service;
  if (service !== 'r7-runner' || typeof actorId !== 'string') return null;
  if (actorId === RUNNER_COMPILE_ACTOR_ID) return Object.freeze({ id: actorId, roles: Object.freeze(['COMPILER'] as const) });
  if (actorId === RUNNER_VERIFY_ACTOR_ID) return Object.freeze({ id: actorId, roles: Object.freeze(['VERIFIER'] as const) });
  return null;
}

export function isRunnerCompileActor(actor: Readonly<Actor>): boolean {
  return actor.id === RUNNER_COMPILE_ACTOR_ID && actor.roles.includes('COMPILER');
}

export function isRunnerVerifyActor(actor: Readonly<Actor>): boolean {
  return actor.id === RUNNER_VERIFY_ACTOR_ID && actor.roles.includes('VERIFIER');
}
