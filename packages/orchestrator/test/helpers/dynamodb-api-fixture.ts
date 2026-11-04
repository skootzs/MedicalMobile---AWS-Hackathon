/** Trusted fictional sessions; DynamoDB Local integration only, never production auth. */
import { ApprovalService } from '../../src/approvals.ts';
import { RequestService } from '../../src/requests.ts';
import { ReviewService } from '../../src/reviews.ts';
import { createLocalApi } from '../../src/server.ts';
import { provisionalSnapshotValidator } from '../../src/snapshots.ts';
import { resolveReviewActor } from './review-fixtures.ts';
import type { DynamoOrchestratorStore } from '../../src/storage/dynamodb.ts';
export const localHeaders=(who:string)=>({authorization:`Bearer fictional-local-${who}`});
const sessions=new Map(['po','clinic','poClinic','backend','release','compiler'].map(who=>[localHeaders(who).authorization,who]));
export function durableApi(store:DynamoOrchestratorStore) {
  const canAccess=(p:unknown,_id:string)=>typeof p==='string'&&[...sessions.values()].includes(p);
  const approvals=new ApprovalService({store,resolveActor:resolveReviewActor});
  const requests=new RequestService({store,resolveActor:resolveReviewActor,validateSnapshot:provisionalSnapshotValidator});
  const reviews=new ReviewService({store,candidates:store,resolveActor:resolveReviewActor,canAccessRequest:canAccess});
  const api=createLocalApi({store,approvals,requests,reviews,authentication:{
    authenticate:r=>{const p=sessions.get(r.headers.authorization??'');return p?{context:p}:null;},
    canAccessRequest:(p,id)=>canAccess(p.context,id),
  }});
  return {api,approvals,requests,reviews};
}
