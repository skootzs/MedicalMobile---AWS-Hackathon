/** TEST ONLY: fictional verified identities, local store and synthetic screening. */
import assert from 'node:assert/strict';
import { InMemoryOrchestratorStore } from '../../src/storage/memory.ts';
import type { InMemoryOptions } from '../../src/storage/memory.ts';
import { provisionalSnapshotValidator } from '../../src/snapshots.ts';
import { RoutingService } from '../../src/routing-service.ts';
import type { RoutingServiceDependencies, RoutingCommand } from '../../src/routing-service.ts';
import { ReviewService } from '../../src/reviews.ts';
import type { WorkflowState } from '../../src/workflow.ts';
import { reviewFixture, resolveReviewActor } from './review-fixtures.ts';
import { submit, next } from './approval-fixtures.ts';
export function routingFixture(options: Partial<InMemoryOptions> = {}) {
  const f = reviewFixture();
  const db = new InMemoryOrchestratorStore({ resolveActor: resolveReviewActor, validateSnapshot: provisionalSnapshotValidator, ...options });
  const deps: RoutingServiceDependencies = { store: db, resolveActor: resolveReviewActor, canAccessRequest: (p, id) => f.canAccessRequest(p, id, 'CLINICAL') };
  return { ...f, db, deps, routing: new RoutingService(deps),
    reviews: new ReviewService({ store: db, candidates: db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest }) };
}
export function routingCommand(s: WorkflowState, eventId = 'fictional-route'): RoutingCommand {
  return { requestId: s.brief.requestId, expectedVersion: s.version, eventId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash };
}
export async function readyWithConcern(db: InMemoryOrchestratorStore) {
  assert.equal((await db.apply(submit(), 'po')).outcome, 'ACCEPTED');
  let s = (await db.getWorkflow('fictional-001'))!, step = next(s);
  if (step.cmd.event.type !== 'SCREENING_COMPLETED') throw Error('fixture');
  step.cmd.event.screening.checks.clinicalSafety = { outcome: 'NEEDS_REVIEW', reasons: ['Fictional escalation requires human clarification and later clinical approval.'] };
  assert.equal((await db.apply(step.cmd, step.who)).outcome, 'ACCEPTED'); s = (await db.getWorkflow('fictional-001'))!;
  step = next(s); assert.equal((await db.apply(step.cmd, step.who)).outcome, 'ACCEPTED');
  return (await db.getWorkflow('fictional-001'))!;
}
