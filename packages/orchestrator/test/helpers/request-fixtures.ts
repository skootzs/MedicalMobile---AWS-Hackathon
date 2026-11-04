/** TEST ONLY: fictional authenticated sessions and simulated internal R3 output. */
import { InMemoryOrchestratorStore } from '../../src/storage/memory.ts';
import type { InMemoryOptions } from '../../src/storage/memory.ts';
import { provisionalSnapshotValidator } from '../../src/snapshots.ts';
import { RequestService } from '../../src/requests.ts';
import type { CurrentRequestCommand, ReviseRequestCommand } from '../../src/requests.ts';
import type { AuthenticationBoundary } from '../../src/auth.ts';
import { screeningAreas } from '../../src/routing.ts';
import type { PreliminaryScreening } from '../../src/routing.ts';
import { resolveActor as approvalActor } from './approval-fixtures.ts';

export const resolveRequestActor = (principal: unknown) => principal === 'po2' ? { id: 'fictional-other-po', roles: ['PO'] as const } : approvalActor(principal);
export const headers = (name: string) => ({ authorization: `Bearer fictional-intake-session-${name}` });
const sessions = new Map(['po', 'po2', 'ai', 'clinic', 'release', 'backend'].map(name => [headers(name).authorization, name]));
export function requestFixture(options: Partial<InMemoryOptions> = {}) {
  const db = new InMemoryOrchestratorStore({ resolveActor: resolveRequestActor, validateSnapshot: provisionalSnapshotValidator, ...options });
  const service = new RequestService({ store: db, resolveActor: resolveRequestActor, validateSnapshot: provisionalSnapshotValidator });
  const authentication: AuthenticationBoundary = {
    authenticate(request) {
      const name = sessions.get(request.headers.authorization ?? '');
      return name ? Object.freeze({ context: name }) : null;
    },
    async canAccessRequest(principal, requestId) {
      const actor = resolveRequestActor(principal.context), state = await db.getWorkflow(requestId);
      return !!actor && !!state && actor.id === state.ownerId;
    },
  };
  return { db, service, authentication };
}
/** Simulates an authenticated backend R3 adapter. No browser route imports it. */
export function mockRole3(service: RequestService) {
  return {
    interpret(command: ReviseRequestCommand) { return service.reviseInterpretation(command, 'ai'); },
    screen(current: CurrentRequestCommand, changes: Partial<PreliminaryScreening> = {}) {
      const screening: PreliminaryScreening = { requestId: current.requestId, revision: current.revision,
        snapshotHash: current.snapshotHash, screeningId: `screen-${current.revision}`, status: 'COMPLETED',
        checks: Object.fromEntries(screeningAreas.map(area => [area, { outcome: 'CLEAR', reasons: [] }])) as unknown as PreliminaryScreening['checks'], ...changes };
      return service.recordScreening({ ...current, screening }, 'ai');
    },
  };
}
