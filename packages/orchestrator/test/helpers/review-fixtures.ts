/** TEST ONLY: fictional verified sessions and explicit request visibility, not assignments. */
import assert from 'node:assert/strict';
import { InMemoryOrchestratorStore } from '../../src/storage/memory.ts';
import { provisionalSnapshotValidator } from '../../src/snapshots.ts';
import { ReviewService } from '../../src/reviews.ts';
import type { ReviewServiceDependencies } from '../../src/reviews.ts';
import type { AuthenticationBoundary } from '../../src/auth.ts';
import { resolveActor, submit, next } from './approval-fixtures.ts';
import type { Actor } from '../../src/workflow.ts';
export function resolveReviewActor(principal: unknown): Actor | null {
  if (principal === 'sd') return { id: 'fictional-designer', roles: ['SERVICE_DESIGNER'] };
  if (principal === 'contributorClinician') return { id: 'fictional-ai', roles: ['CLINICIAN'] };
  if (principal === 'outsider') return { id: 'fictional-outsider', roles: ['CLINICIAN'] };
  return resolveActor(principal);
}
export const reviewerHeaders = (name: string) => ({ authorization: `Bearer fictional-review-session-${name}` });
const known = ['po', 'clinic', 'release', 'sd', 'contributorClinician', 'poClinic', 'clinicRelease', 'outsider', 'ai', 'backend'];
const sessions = new Map(known.map(name => [reviewerHeaders(name).authorization, name]));
export function reviewFixture(changes: Partial<ReviewServiceDependencies> = {}) {
  const db = new InMemoryOrchestratorStore({ resolveActor: resolveReviewActor, validateSnapshot: provisionalSnapshotValidator });
  const visibility = new Map<string, Set<string>>([['fictional-001', new Set(known.filter(name => name !== 'outsider'))]]);
  const canAccessRequest: ReviewServiceDependencies['canAccessRequest'] = (principal, requestId) => typeof principal === 'string' && !!visibility.get(requestId)?.has(principal);
  const reviews = new ReviewService({ store: db, candidates: db, resolveActor: resolveReviewActor, canAccessRequest, ...changes });
  const authentication: AuthenticationBoundary = {
    authenticate(request) { const name = sessions.get(request.headers.authorization ?? ''); return name ? { context: name } : null; },
    canAccessRequest(principal, requestId) { return canAccessRequest(principal.context, requestId, 'CLINICAL'); },
  };
  return { db, reviews, visibility, canAccessRequest, authentication };
}
export async function sdState(db: InMemoryOrchestratorStore) {
  let r = await db.apply(submit(), 'po'); assert.equal(r.outcome, 'ACCEPTED');
  let s = (await db.getWorkflow('fictional-001'))!, step = next(s);
  if (step.cmd.event.type !== 'SCREENING_COMPLETED') throw Error('fixture');
  step.cmd.event.screening.checks.clinicalSafety = { outcome: 'NEEDS_REVIEW', reasons: ['Fictional escalation requires specialist clarification.'] };
  r = await db.apply(step.cmd, step.who); assert.equal(r.outcome, 'ACCEPTED');
  s = (await db.getWorkflow('fictional-001'))!;
  for (let i = 0; i < 2; i++) { step = next(s); r = await db.apply(step.cmd, step.who); assert.equal(r.outcome, 'ACCEPTED'); s = (await db.getWorkflow('fictional-001'))!; }
  assert.equal(s.status, 'NEEDS_SD_REVIEW'); return s;
}
