import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand,QueryCommand,UpdateCommand,ScanCommand } from '@aws-sdk/lib-dynamodb';
import { CompilationHandoffService } from '../src/compilations.ts';
import { CompilationResultService } from '../src/compilation-results.ts';
import { DurableLogicModelReferences } from '../src/storage/durable-objects.ts';
import { FictionalArtifacts } from './helpers/compilation-result-fixtures.ts';
import type { CompilationExecution } from '../src/compilation-result-contracts.ts';
import { RequestService } from '../src/requests.ts';
import { localClient,createLocalTable,durableLocalStore,LocalDiskObjects } from './helpers/dynamodb-local-fixtures.ts';
import { durableApi,localHeaders } from './helpers/dynamodb-api-fixture.ts';
import { content,next,command as eventCommand,preview } from './helpers/approval-fixtures.ts';
import { provisionalSnapshotValidator,requestPreviewIdentity } from '../src/snapshots.ts';
import { resolveReviewActor } from './helpers/review-fixtures.ts';
import { CheckerResultService } from '../src/checkers.ts';
import { FictionalChecker } from './helpers/checker-fixtures.ts';
import { ApprovalService } from '../src/approvals.ts';
import { DynamoOrchestratorStore } from '../src/storage/dynamodb.ts';
import type { WorkflowState,WorkflowStatus } from '../src/workflow.ts';
import type { DynamoStoreOptions } from '../src/storage/dynamodb.ts';

const endpoint=process.env.R2_DYNAMODB_LOCAL_ENDPOINT;
const integration={skip:!endpoint};
async function setup(t:TestContext) {
  const table=`r2-local-test-${randomUUID()}`,directory=await mkdtemp(join(tmpdir(),'r2-durable-')),client=localClient(endpoint!);
  await createLocalTable(client.client,table);
  t.after(async()=>{const cleanup=localClient(endpoint!);try{await cleanup.client.send(new DeleteTableCommand({TableName:table}));}finally{cleanup.client.destroy();client.client.destroy();await rm(directory,{recursive:true,force:true});}});
  const db=durableLocalStore(client.document,table,directory);
  return {table,directory,client,db,newStore:(options:Partial<DynamoStoreOptions>={})=>durableLocalStore(client.document,table,directory,options)};
}
async function createRequest(db:DynamoOrchestratorStore,eventId='fictional-durable-create') {
  const h=durableApi(db);
  try {
    const r=await h.api.inject({method:'POST',url:'/api/requests',headers:localHeaders('po'),payload:{eventId,expectedVersion:0,content:content()}});
    assert.equal(r.statusCode,201,r.body);const id=r.json().requestId as string;assert.ok(id);return id;
  }finally{await h.api.close();}
}
async function advance(db:DynamoOrchestratorStore,id:string,target:WorkflowStatus) {
  let s=(await db.getWorkflow(id))!;
  while(s.status!==target) {
    if(s.status==='WAITING_FOR_LOGIC_CHECKS') {
      const checker=new CheckerResultService({store:db,resolveActor:resolveReviewActor,canAccessRequest:()=>true,
        checker:{checkerActorId:'fictional-checker',checkerId:'fictional-r4-checker',checkerVersion:'fixture-v1'}});
      const c={requestId:id,revision:s.brief.revision,snapshotHash:s.brief.snapshotHash,...s.logic!,expectedVersion:s.version,eventId:'fictional-authorize-durable-check'};
      const a=await checker.authorize(c,'backend');assert.equal(a.status,'AUTHORIZED',a.reason);
      const snapshot=await db.getSnapshot({kind:'LOGIC_MODEL',requestId:id,revision:s.logic!.logicRevision,requestPreview:{requestId:id,revision:s.brief.revision,snapshotHash:s.brief.snapshotHash}});
      if(snapshot?.kind!=='LOGIC_MODEL')throw Error('fixture');
      const report=await new FictionalChecker().check(a.invocation!,snapshot);
      const r=await checker.ingest({...c,eventId:'fictional-durable-check-result',invocationId:a.invocation!.invocationId,report},'checker');assert.equal(r.status,'ACCEPTED',r.reason);
    }else{const step=next(s),r=await db.apply(step.cmd,step.who);assert.equal(r.outcome,'ACCEPTED',r.reason);}
    s=(await db.getWorkflow(id))!;
  }
  return s;
}
function approval(s:WorkflowState,eventId='fictional-durable-clinical') {
  return {type:'CLINICAL_DECISION' as const,requestId:s.brief.requestId,eventId,expectedVersion:s.version,requestRevision:s.brief.revision,
    requestSnapshotHash:s.brief.snapshotHash,...s.logic!,checkerReportId:s.checks!.reportId,decision:'APPROVE' as const};
}

test('LOCAL: Fastify restart plus NEW Node process preserves pending approval, evidence, history and audit',integration,async t=>{
  const f=await setup(t);const id=await createRequest(f.db),pending=await advance(f.db,id,'WAITING_FOR_CLINICAL_APPROVAL');
  const before=await f.db.listAudit(id),snapshots=await f.db.listSnapshots(id);
  const oldApi=durableApi(f.db);await oldApi.api.close();f.client.client.destroy();
  // New OS process has no access to any old service, planner, object map or SDK client.
  const child=await promisify(execFile)(process.execPath,['--experimental-strip-types','test/helpers/dynamodb-restart-reader.ts',endpoint!,f.table,f.directory,id],{cwd:process.cwd(),maxBuffer:1024*1024});
  const recovered=JSON.parse(child.stdout);
  assert.equal(recovered.code,200);assert.equal(recovered.context.status,'WAITING_FOR_CLINICAL_APPROVAL');
  assert.equal(recovered.context.eligibility.eligible,true);assert.equal(recovered.context.logicModel.snapshotHash,pending.logic!.logicHash);
  assert.ok(recovered.queue.items.some((i:{requestId:string})=>i.requestId===id));assert.equal(recovered.audits,before.length);assert.equal(recovered.snapshots,snapshots.length);
  // Recreate SDK client, disk-object provider, repository and HTTP application.
  const freshClient=localClient(endpoint!),db=durableLocalStore(freshClient.document,f.table,f.directory),h=durableApi(db);
  try {
    const {type:_type,requestId:_id,...body}=approval(pending);
    const self=await h.api.inject({method:'POST',url:`/api/requests/${id}/clinical-decisions`,headers:localHeaders('poClinic'),payload:{...body,eventId:'self-approval'}});assert.equal(self.statusCode,403,self.body);
    const r=await h.api.inject({method:'POST',url:`/api/requests/${id}/clinical-decisions`,headers:localHeaders('clinic'),payload:body});assert.equal(r.statusCode,200,r.body);
    assert.equal((await db.getWorkflow(id))?.status,'CLINICALLY_APPROVED');
    assert.deepEqual((await db.listAudit(id)).slice(0,before.length),before);assert.deepEqual(await db.listSnapshots(id),snapshots);
    const stale=await h.api.inject({method:'POST',url:`/api/requests/${id}/clinical-decisions`,headers:localHeaders('clinic'),payload:{...body,eventId:'stale-approval'}});assert.equal(stale.statusCode,409,stale.body);
    const unauth=await h.api.inject({method:'POST',url:`/api/requests/${id}/clinical-decisions`,payload:body});assert.equal(unauth.statusCode,401);
    const wrong=await h.api.inject({method:'POST',url:`/api/requests/${id}/clinical-decisions`,headers:localHeaders('po'),payload:{...body,eventId:'wrong-role',expectedVersion:pending.version+1}});assert.equal(wrong.statusCode,403,wrong.body);
    const item=await freshClient.document.send(new GetCommand({TableName:f.table,Key:{pk:`REQ#${id}`,sk:`APPROVAL#${body.eventId}`},ConsistentRead:true}));assert.equal(item.Item?.status,'APPROVED');assert.equal(item.Item?.decision,'approved');assert.equal(item.Item?.superseded,false);
  }finally{await h.api.close();freshClient.client.destroy();}
});
test('LOCAL: independent adapter instances serialize concurrent approval attempts',integration,async t=>{
  const f=await setup(t),id=await createRequest(f.db),s=await advance(f.db,id,'WAITING_FOR_CLINICAL_APPROVAL');
  const a=new ApprovalService({store:f.newStore(),resolveActor:resolveReviewActor}),b=new ApprovalService({store:f.newStore(),resolveActor:resolveReviewActor});
  const results=await Promise.all([a.execute(approval(s,'first'),'clinic'),b.execute(approval(s,'second'),'clinic')]);
  assert.equal(results.filter(r=>r.status==='SUCCESS').length,1,JSON.stringify(results));assert.equal(results.filter(r=>r.status==='STALE_VERSION').length,1,JSON.stringify(results));
  assert.equal((await f.newStore().getWorkflow(id))?.version,s.version+1);assert.equal((await f.db.listEvidence(id)).filter(e=>e.kind==='CLINICAL_DECISION').length,1);
});
test('LOCAL: duplicate approval retries survive separate adapters without duplicate decisions',integration,async t=>{
  const f=await setup(t),id=await createRequest(f.db),s=await advance(f.db,id,'WAITING_FOR_CLINICAL_APPROVAL');
  const a=new ApprovalService({store:f.newStore(),resolveActor:resolveReviewActor}),b=new ApprovalService({store:f.newStore(),resolveActor:resolveReviewActor});
  const results=await Promise.all([a.execute(approval(s),'clinic'),b.execute(approval(s),'clinic')]);
  assert.equal(results.filter(r=>r.status==='SUCCESS').length,1);assert.equal(results.filter(r=>r.status==='DUPLICATE_EVENT').length,1,JSON.stringify(results));
  assert.equal((await f.db.listEvidence(id)).filter(e=>e.kind==='CLINICAL_DECISION').length,1);
});
test('LOCAL: real canceled transaction leaves state, approval, receipt and audit unchanged',integration,async t=>{
  const f=await setup(t),id=await createRequest(f.db),s=await advance(f.db,id,'WAITING_FOR_CLINICAL_APPROVAL'),before=await f.db.listAudit(id);
  const broken=f.newStore({testBeforeTransaction:actions=>actions.push({ConditionCheck:{TableName:f.table,Key:{pk:'MISSING#FAULT',sk:'META'},ConditionExpression:'attribute_exists(pk)'}})});
  const r=await new ApprovalService({store:broken,resolveActor:resolveReviewActor}).execute(approval(s),'clinic');assert.equal(r.status,'STORAGE_FAILURE');
  assert.deepEqual(await f.newStore().getWorkflow(id),s);assert.deepEqual(await f.db.listAudit(id),before);assert.equal(await f.db.getReceipt(id,'fictional-durable-clinical'),null);
  const row=await f.client.document.send(new GetCommand({TableName:f.table,Key:{pk:`REQ#${id}`,sk:'APPROVAL#fictional-durable-clinical'},ConsistentRead:true}));assert.equal(row.Item,undefined);
});
test('LOCAL: job intent/outbox/state/receipt commit together, canceled creation leaves none',integration,async t=>{
  const f=await setup(t),id=await createRequest(f.db),s=await advance(f.db,id,'READY_FOR_LOGIC_PROPOSAL'),before=await f.db.listAudit(id),step=next(s);
  const broken=f.newStore({testBeforeTransaction:actions=>actions.push({ConditionCheck:{TableName:f.table,Key:{pk:'MISSING#FAULT',sk:'META'},ConditionExpression:'attribute_exists(pk)'}})});
  await assert.rejects(()=>broken.apply(step.cmd,step.who));assert.deepEqual(await f.db.getWorkflow(id),s);assert.deepEqual(await f.db.listJobs(id),[]);assert.deepEqual(await f.db.listAudit(id),before);
  assert.equal((await f.newStore().apply(step.cmd,step.who)).outcome,'ACCEPTED');const jobs=await f.db.listJobs(id);assert.equal(jobs.length,1);
  const rows=await f.client.document.send(new QueryCommand({TableName:f.table,KeyConditionExpression:'pk = :p',ExpressionAttributeValues:{':p':`JOB#${jobs[0].jobId}`},ConsistentRead:true}));
  assert.deepEqual(rows.Items?.map(i=>i.sk).sort(),['META','OUTBOX']);
  assert.equal(rows.Items?.find(i=>i.sk==='OUTBOX')?.payload.jobId,jobs[0].jobId);
  assert.equal(rows.Items?.find(i=>i.sk==='META')?.gsi1pk,`REQ#${id}`);
  assert.match(rows.Items?.find(i=>i.sk==='META')?.gsi1sk,/^JOB#\d{4}-/);
});
test('LOCAL: revisions preserve immutable history and supersede projected approvals atomically',integration,async t=>{
  const f=await setup(t),id=await createRequest(f.db),s=await advance(f.db,id,'WAITING_FOR_CLINICAL_APPROVAL');
  assert.equal((await new ApprovalService({store:f.db,resolveActor:resolveReviewActor}).execute(approval(s),'clinic')).status,'SUCCESS');
  const approved=(await f.db.getWorkflow(id))!,snapshot=preview(2,id);
  const r=await f.db.apply(eventCommand(approved,{type:'REVISE_REQUEST',brief:{...snapshot.content,...requestPreviewIdentity(snapshot)}},{snapshots:[snapshot]}),'po');assert.equal(r.outcome,'ACCEPTED');
  const recreated=f.newStore();assert.equal((await recreated.getWorkflow(id))?.clinicalApproval,null);assert.equal((await recreated.listSnapshots(id)).length,3);
  const row=await f.client.document.send(new GetCommand({TableName:f.table,Key:{pk:`REQ#${id}`,sk:'APPROVAL#fictional-durable-clinical'},ConsistentRead:true}));assert.equal(row.Item?.status,'SUPERSEDED');assert.equal(row.Item?.superseded,true);
  assert.ok((await recreated.listEvidence(id)).some(e=>e.kind==='CLINICAL_DECISION'));
});
test('LOCAL: corrupt snapshot bytes fail closed after restart',integration,async t=>{
  const f=await setup(t),id=await createRequest(f.db),s=(await f.db.getWorkflow(id))!;
  await writeFile(join(f.directory,'snapshots',`${s.brief.snapshotHash}.json`),'fictional corruption');
  await assert.rejects(()=>f.newStore().getWorkflow(id),/OBJECT_INTEGRITY/);
});
test('durable configuration cannot silently select memory',()=>{
  assert.throws(()=>new DynamoOrchestratorStore({} as never),/DURABLE_CONFIGURATION_REQUIRED/);
});

async function compiling(t:TestContext) {
  const f=await setup(t),id=await createRequest(f.db),s=await advance(f.db,id,'WAITING_FOR_CLINICAL_APPROVAL');
  assert.equal((await new ApprovalService({store:f.db,resolveActor:resolveReviewActor}).execute(approval(s),'clinic')).status,'SUCCESS');
  const approved=(await f.db.getWorkflow(id))!;
  const started=await new CompilationHandoffService({store:f.db,resolveActor:resolveReviewActor,canAccessRequest:()=>true,
    snapshotReferences:new DurableLogicModelReferences(new LocalDiskObjects(f.directory))}).start({requestId:id,revision:approved.brief.revision,snapshotHash:approved.brief.snapshotHash,
      logicModelRevision:approved.logic!.logicRevision,logicModelHash:approved.logic!.logicHash,expectedVersion:approved.version,eventId:'fictional-compile-start',clinicalApprovalId:approved.clinicalApproval!.eventId},'backend');
  assert.equal(started.status,'INTENT_RECORDED',started.reason);const job=started.job!;
  const model=await f.db.getSnapshot({kind:'LOGIC_MODEL',requestId:id,revision:job.logicModelRevision,requestPreview:job.requestPreview});if(model?.kind!=='LOGIC_MODEL')throw Error('fixture');
  const artifacts=new FictionalArtifacts(),execution=artifacts.make(job,model);
  const publish=async(value:CompilationExecution)=>f.client.document.send(new UpdateCommand({TableName:f.table,Key:{pk:`JOB#${job.jobId}`,sk:'META'},
    UpdateExpression:'SET executionRecordVersion = :v, attempt = :a, #s = :s, execution = :e',ExpressionAttributeNames:{'#s':'status'},
    ExpressionAttributeValues:{':v':value.recordVersion,':a':value.attempt,':s':value.status,':e':value}}));
  await publish(execution); // Simulated R7 writer, real DynamoDB record, no runner/compile execution.
  const condition:DynamoStoreOptions['executionCondition']=e=>({TableName:f.table,Key:{pk:`JOB#${e.jobId}`,sk:'META'},
    ConditionExpression:'executionRecordVersion = :v AND attempt = :a AND #s = :s',ExpressionAttributeNames:{'#s':'status'},
    ExpressionAttributeValues:{':v':e.recordVersion,':a':e.attempt,':s':e.status}});
  const store=f.newStore({executionCondition:condition});
  const source={async getCurrent(requestId:string,jobId:string){const r=await f.client.document.send(new GetCommand({TableName:f.table,Key:{pk:`JOB#${jobId}`,sk:'META'},ConsistentRead:true}));return r.Item?.requestId===requestId?r.Item.execution as CompilationExecution:null;}};
  const deps={store,executions:source,artifacts,resolveActor:resolveReviewActor,canAccessRequest:()=>true,authorizeRunner:(a:{id:string})=>a.id==='fictional-compiler'};
  const command={requestId:id,jobId:job.jobId,eventId:'fictional-durable-compiled',expectedVersion:job.workflowVersion,attempt:execution.attempt,executionRecordVersion:execution.recordVersion};
  return {...f,id,job,execution,publish,condition,store,artifacts,deps,command};
}

test('LOCAL: compilation, result evidence and pending release approval recover; R7 source remains authoritative',integration,async t=>{
  const f=await compiling(t),r=await new CompilationResultService(f.deps).ingest(f.command,'compiler');assert.equal(r.status,'ACCEPTED',r.reason);
  const db=f.newStore({executionCondition:f.condition});assert.deepEqual(await db.getCompilationResult(f.id,f.job.jobId),r.result);
  assert.equal((await db.getWorkflow(f.id))?.status,'WAITING_FOR_VERIFICATION');
  // Historical retries must not require the current runner row to remain at the old attempt.
  await f.publish({...f.execution,attempt:2,recordVersion:'fictional-later-execution'});
  assert.equal((await new CompilationResultService({...f.deps,store:db}).ingest(f.command,'compiler')).status,'DUPLICATE_EVENT');
  const pending=await advance(db,f.id,'WAITING_FOR_RELEASE_APPROVAL');
  const h=durableApi(f.newStore());try{const q=await h.reviews.queue('RELEASE','release');assert.equal(q.status,'SUCCESS');if(q.status==='SUCCESS')assert.ok(q.items.some(i=>i.requestId===f.id));}finally{await h.api.close();}
  const release={type:'RELEASE_DECISION' as const,requestId:f.id,eventId:'fictional-durable-release',expectedVersion:pending.version,requestRevision:pending.brief.revision,
    requestSnapshotHash:pending.brief.snapshotHash,...pending.logic!,decision:'APPROVE' as const,clinicalApprovalEventId:pending.clinicalApproval!.eventId,
    compilationId:pending.artifact!.compilationId,artifactHash:pending.artifact!.artifactHash,verificationId:pending.verification!.verificationId,verificationReportHash:pending.verification!.reportHash};
  const approvals=new ApprovalService({store:f.newStore(),resolveActor:resolveReviewActor});
  assert.equal((await approvals.execute({...release,eventId:'clinician-cannot-release'},'clinicRelease')).status,'REJECTED');
  assert.equal((await approvals.execute(release,'release')).status,'SUCCESS');assert.equal((await f.newStore().getWorkflow(f.id))?.status,'RELEASE_APPROVED');
});
test('LOCAL: R7 attempt changes during byte verification cancel finalization in the actual transaction',integration,async t=>{
  const f=await compiling(t),service=new CompilationResultService({...f.deps,artifacts:{async verify(input){const result=await f.artifacts.verify(input);await f.publish({...f.execution,attempt:2,recordVersion:'fictional-v2'});return result;}}});
  const r=await service.ingest(f.command,'compiler');assert.equal(r.status,'STALE_VERSION',r.reason);assert.equal(r.reason,'STALE_JOB_ATTEMPT');
  assert.equal((await f.newStore().getWorkflow(f.id))?.status,'COMPILING');assert.equal(await f.db.getCompilationResult(f.id,f.job.jobId),null);
  assert.equal((await f.db.listAudit(f.id)).at(-1)?.reason,'STALE_JOB_ATTEMPT');
});
test('LOCAL: missing durable table returns HTTP 503 without memory fallback',integration,async t=>{
  const f=await setup(t),db=durableLocalStore(f.client.document,`r2-local-test-missing-${randomUUID()}`,f.directory),h=durableApi(db);
  try{const r=await h.api.inject({method:'POST',url:'/api/requests',headers:localHeaders('po'),payload:{eventId:'fictional-unavailable',expectedVersion:0,content:content()}});assert.equal(r.statusCode,503,r.body);}
  finally{await h.api.close();}
});
test('LOCAL: large fictional content stays in immutable objects, not oversized DynamoDB items',integration,async t=>{
  const f=await setup(t),service=new RequestService({store:f.db,resolveActor:resolveReviewActor,validateSnapshot:provisionalSnapshotValidator});
  const r=await service.create({eventId:'fictional-large-request',expectedVersion:0,content:{...content(),objective:'Fictional training-only content. '.repeat(16000)}},'po');
  assert.equal(r.status,'SUCCESS',r.reason);assert.ok((await f.newStore().getWorkflow(r.requestId!))!.brief.objective.length>400*1024);
  const rows=await f.client.document.send(new ScanCommand({TableName:f.table}));for(const item of rows.Items??[])assert.ok(Buffer.byteLength(JSON.stringify(item))<300*1024);
});
test('LOCAL: creation idempotency and changed-payload conflicts survive new adapters',integration,async t=>{
  const f=await setup(t),first=new RequestService({store:f.newStore(),resolveActor:resolveReviewActor,validateSnapshot:provisionalSnapshotValidator});
  const command={eventId:'fictional-stable-creation',expectedVersion:0 as const,content:content()};const a=await first.create(command,'po');assert.equal(a.status,'SUCCESS');
  const second=new RequestService({store:f.newStore(),resolveActor:resolveReviewActor,validateSnapshot:provisionalSnapshotValidator});
  assert.equal((await second.create(command,'po')).status,'DUPLICATE_EVENT');
  assert.equal((await second.create({...command,content:content(2)},'po')).status,'REJECTED');assert.equal((await f.db.getWorkflow(a.requestId!))?.version,1);
});
test('LOCAL: compilation finalization without the R7 transactional execution condition fails closed',integration,async t=>{
  const f=await compiling(t),service=new CompilationResultService({...f.deps,store:f.newStore()});
  const r=await service.ingest(f.command,'compiler');assert.equal(r.reason,'EXECUTION_CONDITION_REQUIRED');
  assert.equal((await f.db.getWorkflow(f.id))?.status,'COMPILING');assert.equal(await f.db.getCompilationResult(f.id,f.job.jobId),null);
});
