import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { canonicalizeJson } from '../snapshots.ts';
import type { Snapshot } from '../snapshots.ts';
import type { WorkflowState, WorkflowStatus } from '../workflow.ts';
import type { CompilationExecution } from '../compilation-result-contracts.ts';
import type { VerificationExecution } from '../verification-result-contracts.ts';
import { InMemoryOrchestratorStore } from './memory.ts';
import type { InMemoryOptions, RepositoryImage } from './memory.ts';
import { StorageError } from './requests.ts';
import type { ApplyCommand, StoreDependencies, ReviewCandidateSource } from './requests.ts';
import type { JobDeliveryAttempt } from './jobs.ts';
import type { AuthorizeCheckerInput, CheckerStore } from './checkers.ts';
import type { DraftingResultStore } from './drafting-results.ts';
import type { CompilationResultStore } from './compilation-results.ts';
import type { VerificationResultStore } from './verification-results.ts';
import type { AuditRecord } from './audit.ts';
import type { EvidenceRecord } from './artifacts.ts';
import { readVerified, writeVerified, sha256, snapshotObjectBytes } from './durable-objects.ts';
import type { DurableObjects, ImmutableObjectReference } from './durable-objects.ts';
import { verifySnapshot } from './snapshots.ts';

type Tx = NonNullable<TransactWriteCommandInput['TransactItems']>;
interface IndexContract {
  name: string; partitionAttribute: string; sortAttribute: string;
  partitionValue(value: string): string | null; sortValue(value: string): string;
}
/** Required configuration: no guessed shared GSI attribute/key names. */
export interface DynamoLayout {
  reviewerIndex: IndexContract;
  jobsByRequestIndex: IndexContract;
  auditSortKey(record: AuditRecord): string;
  evidenceSortKey(record: EvidenceRecord): string;
  receiptSortKey(eventId: string): string;
  revisionSortKey(revision: number): string;
}
export interface DynamoStoreOptions extends StoreDependencies {
  client: DynamoDBDocumentClient;
  tableName: string;
  objects: DurableObjects;
  layout: DynamoLayout;
  /** Required for compilation finalization. Condition JOB/META version/attempt/status
   * in THIS transaction, using R7's published field names. No blind client flags. */
  executionCondition?(expected: Readonly<CompilationExecution>): NonNullable<Tx[number]['ConditionCheck']>;
  /** Same for VERIFY_BUILD finalization: condition the R7 verify JOB/META attempt. */
  verificationCondition?(expected: Readonly<VerificationExecution>): NonNullable<Tx[number]['ConditionCheck']>;
  /** Integration-test fault only. Cannot be used to emulate an accepted transaction. */
  testBeforeTransaction?(actions: Tx): void;
}
interface PersistedImage { format: 'r2-durable-image-v1'; requestId: string; image: RepositoryImage }
interface Meta { pk: string; sk: string; requestId: string; r2StorageVersion: number; workflowVersion: number; status: string; createdAt: string; repositoryRef: ImmutableObjectReference }
const same = (a: unknown, b: unknown) => canonicalizeJson(a) === canonicalizeJson(b);
const pk = (id: string) => `REQ#${id}`;
const entries = (image: RepositoryImage, name: string) => image.collections[name] ?? [];
const maps = (image: RepositoryImage, name: string) => new Map(entries(image,name));
const safeId = (id: string) => { if (typeof id !== 'string' || !id.trim() || id.length > 100) throw new StorageError('INVALID_REQUEST_ID'); };
/** Durable repository. Each operation reads DynamoDB META and an immutable image fresh.
 * InMemory is used ONLY as a stateless transition planner; it never backs a fallback.
 * Provisional repository-image serialization needs R7 review before sandbox integration. */
export class DynamoOrchestratorStore implements CheckerStore, DraftingResultStore, CompilationResultStore, VerificationResultStore, ReviewCandidateSource {
  #o: DynamoStoreOptions;
  constructor(options: DynamoStoreOptions) {
    if (!options?.tableName || !options.client || !options.objects || !options.layout || typeof options.resolveActor !== 'function' || typeof options.validateSnapshot !== 'function') throw new StorageError('DURABLE_CONFIGURATION_REQUIRED');
    for (const index of [options.layout.reviewerIndex,options.layout.jobsByRequestIndex]) {
      if (!index?.name || !index.partitionAttribute || !index.sortAttribute || index.partitionAttribute === index.sortAttribute ||
        [index.partitionAttribute,index.sortAttribute].some(k => ['pk','sk','requestId','status','r2StorageVersion','repositoryRef','workflowVersion','jobId','jobType','mode','idempotencyKey','objectRef','revision','snapshotHash','clinicalApprovalId','logicModelHash'].includes(k)) ||
        typeof index.partitionValue !== 'function' || typeof index.sortValue !== 'function') throw new StorageError('R7_INDEX_CONTRACT_REQUIRED');
    }
    for (const key of ['auditSortKey','evidenceSortKey','receiptSortKey','revisionSortKey'] as const) if (typeof options.layout[key] !== 'function') throw new StorageError('R7_RECORD_CONTRACT_REQUIRED');
    this.#o = options;
  }
  #planner(image?: RepositoryImage) {
    const options: InMemoryOptions = { resolveActor: this.#o.resolveActor, validateSnapshot: this.#o.validateSnapshot, ...(this.#o.now ? { now: this.#o.now } : {}),
      // The actual acceptance condition is appended to the DynamoDB transaction below.
      ...(this.#o.executionCondition ? { compilationExecutionIsCurrent: () => true } : {}),
      ...(this.#o.verificationCondition ? { verificationExecutionIsCurrent: () => true } : {}) };
    return image ? InMemoryOrchestratorStore.restoreRepositoryImage(options,image) : new InMemoryOrchestratorStore(options);
  }
  async #load(requestId: string) {
    safeId(requestId);
    const found = await this.#o.client.send(new GetCommand({ TableName: this.#o.tableName, Key: {pk:pk(requestId),sk:'META'}, ConsistentRead:true }));
    const meta = found.Item as Meta | undefined;
    if (!meta) return { meta, planner:this.#planner() };
    if (meta.requestId !== requestId || !Number.isSafeInteger(meta.r2StorageVersion) || meta.r2StorageVersion < 1) throw new StorageError('DURABLE_META_INTEGRITY');
    const raw = await readVerified(this.#o.objects,meta.repositoryRef);
    const persisted = JSON.parse(raw.toString()) as PersistedImage;
    if (persisted.format !== 'r2-durable-image-v1' || persisted.requestId !== requestId || !persisted.image?.collections) throw new StorageError('DURABLE_IMAGE_INTEGRITY');
    const image = persisted.image;
    image.collections.snapshots = await Promise.all(entries(image,'snapshots').map(async ([key,value]) => {
      const ref = value as ImmutableObjectReference;
      const bytes = await readVerified(this.#o.objects,ref);
      const snapshot = verifySnapshot({ ...JSON.parse(bytes.toString()), snapshotHash:ref.sha256 },this.#o.validateSnapshot);
      if (snapshot.requestId !== requestId) throw new StorageError('SNAPSHOT_SCOPE_MISMATCH');
      return [key,canonicalizeJson(snapshot)] as const;
    }));
    for (const [name, rows] of Object.entries(image.collections)) for (const [key] of rows) {
      const owner = ['workflows','audits'].includes(name) ? key : JSON.parse(key)[0];
      if (owner !== requestId) throw new StorageError('DURABLE_SCOPE_MISMATCH');
    }
    const planner = this.#planner(image), state = await planner.getWorkflow(requestId);
    await planner.listSnapshots(requestId); await planner.listEvidence(requestId);
    if ((state?.version ?? 0) !== meta.workflowVersion || (state?.status ?? 'UNCREATED') !== meta.status) throw new StorageError('DURABLE_STATE_INTEGRITY');
    return { meta,planner };
  }
  async #saveImage(requestId: string, image: RepositoryImage) {
    const durable = structuredClone(image);
    const refs = new Map<string,ImmutableObjectReference>();
    durable.collections.snapshots = await Promise.all(entries(image,'snapshots').map(async ([key,value]) => {
      const snapshot = verifySnapshot(JSON.parse(value as string),this.#o.validateSnapshot);
      const ref = await writeVerified(this.#o.objects,`snapshots/${snapshot.snapshotHash}.json`,snapshotObjectBytes(snapshot));
      refs.set(snapshot.snapshotHash,ref); return [key,ref] as const;
    }));
    const bytes = Buffer.from(canonicalizeJson({ format:'r2-durable-image-v1', requestId, image:durable }));
    const ref = await writeVerified(this.#o.objects,`snapshots/r2-records/${sha256(bytes)}.json`,bytes);
    return { ref,refs };
  }
  async #recordRef(value: unknown) {
    const bytes = Buffer.from(canonicalizeJson(value));
    return writeVerified(this.#o.objects,`snapshots/r2-records/${sha256(bytes)}.json`,bytes);
  }
  #index(index: IndexContract, partition: string, sort: string) {
    const value=index.partitionValue(partition);return value===null?{}:{ [index.partitionAttribute]:value, [index.sortAttribute]:index.sortValue(sort) };
  }
  async #transaction(requestId: string, before: RepositoryImage, after: RepositoryImage, meta: Meta | undefined, command?: ApplyCommand): Promise<Tx> {
    const {ref,refs} = await this.#saveImage(requestId,after);
    const state = maps(after,'workflows').get(requestId) as WorkflowState | undefined;
    const actions: Tx = [];
    const put = (item: Record<string,unknown>, mutable = false) => {
      // Conservative headroom below DynamoDB's 400 KiB / 4 MiB transaction limits.
      if (Buffer.byteLength(canonicalizeJson(item)) > 300*1024) throw new StorageError('DYNAMODB_ITEM_TOO_LARGE');
      actions.push({Put:{TableName:this.#o.tableName,Item:item,
        ConditionExpression:mutable && meta ? '#v = :v' : 'attribute_not_exists(pk)',
        ...(mutable && meta ? {ExpressionAttributeNames:{'#v':'r2StorageVersion'},ExpressionAttributeValues:{':v':meta.r2StorageVersion}} : {})}});
    };
    const lastAudit=((maps(after,'audits').get(requestId)??[]) as AuditRecord[]).at(-1);
    const createdAt=meta?.createdAt??lastAudit?.recordedAt;
    if(!createdAt)throw new StorageError('MISSING_DURABLE_TIMESTAMP');
    put({pk:pk(requestId),sk:'META',requestId,createdAt,r2StorageVersion:(meta?.r2StorageVersion??0)+1,workflowVersion:state?.version??0,status:state?.status??'UNCREATED',repositoryRef:ref,
      ...(state ? this.#index(this.#o.layout.reviewerIndex,state.status,createdAt) : {})},true);
    const previousState = maps(before,'workflows').get(requestId) as WorkflowState | undefined;
    for (const field of ['clinicalApproval','releaseApproval'] as const) {
      const old = previousState?.[field], current = state?.[field];
      if (old && old.eventId !== current?.eventId) actions.push({Update:{TableName:this.#o.tableName,Key:{pk:pk(requestId),sk:`APPROVAL#${old.eventId}`},
        UpdateExpression:'SET #s = :superseded, supersededAtWorkflowVersion = :v, superseded = :yes',ConditionExpression:'attribute_exists(pk)',
        ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':superseded':'SUPERSEDED',':v':state?.version??0,':yes':true}}});
    }
    const added = (name: string) => entries(after,name).filter(([key,value]) => {
      const old = maps(before,name); if (!old.has(key)) return true;
      if (!same(old.get(key),value)) throw new StorageError('IMMUTABLE_RECORD_OVERWRITE');
      return false;
    });
    for (const [,bytes] of added('snapshots')) {
      const s = JSON.parse(bytes as string) as Snapshot;
      put({pk:`SNAP#${s.snapshotHash}`,sk:'META',requestId,kind:s.kind,revision:s.revision,snapshotHash:s.snapshotHash,objectRef:refs.get(s.snapshotHash)!});
      if (s.kind === 'REQUEST_PREVIEW') put({pk:pk(requestId),sk:this.#o.layout.revisionSortKey(s.revision),requestId,revision:s.revision,snapshotHash:s.snapshotHash,objectRef:refs.get(s.snapshotHash)!});
    }
    for (const [,value] of added('receipts')) {
      const r = value as {eventId:string}; put({pk:pk(requestId),sk:this.#o.layout.receiptSortKey(r.eventId),requestId,objectRef:await this.#recordRef(value)});
    }
    for (const name of ['jobs','compilationJobs','verifyBuildJobs']) for (const [,value] of added(name)) {
      const j = value as {jobId:string;jobType:string;idempotencyKey:string};
      const jobCreatedAt=(value as {createdAt?:string}).createdAt??lastAudit!.recordedAt;
      const payload={...(value as object),createdAt:jobCreatedAt};
      put({...payload,pk:`JOB#${j.jobId}`,sk:'META',status:'requested',...this.#index(this.#o.layout.jobsByRequestIndex,requestId,jobCreatedAt)});
      // R7's Pipe sends OUTBOX.payload. No second publisher or direct SQS send.
      put({pk:`JOB#${j.jobId}`,sk:'OUTBOX',requestId,jobId:j.jobId,jobType:j.jobType,idempotencyKey:j.idempotencyKey,payload});
    }
    for (const name of ['draftingResults','compilationResults','verificationResults']) for (const [,value] of added(name)) {
      const r = value as {jobId:string;eventId:string}; put({pk:`JOB#${r.jobId}`,sk:`RECEIPT#R2#${r.eventId}`,requestId,objectRef:await this.#recordRef(value)});
    }
    for (const [,value] of added('evidence')) {
      const e = value as EvidenceRecord, event = e.event;
      const approval = event.type === 'CLINICAL_DECISION' || event.type === 'RELEASE_DECISION';
      put({pk:pk(requestId),sk:approval?`APPROVAL#${event.eventId}`:this.#o.layout.evidenceSortKey(e),requestId,kind:e.kind,
        ...(approval ? {approvalId:event.eventId,decision:event.decision==='APPROVE'?'approved':event.decision==='REJECT'?'rejected':'returned',superseded:false,status:event.decision === 'APPROVE'?'APPROVED':event.decision === 'REJECT'?'REJECTED':'RETURNED',
          logicModelHash:event.type==='CLINICAL_DECISION'?event.logicHash:event.evidence.logicHash,logicModelRevision:event.type==='CLINICAL_DECISION'?event.logicRevision:event.evidence.logicRevision,
          ...(event.type==='RELEASE_DECISION'?{artifactHash:event.evidence.artifactHash,verificationId:event.evidence.verificationId,verificationReportHash:event.evidence.reportHash}:{}),revision:event.request.revision,reviewerId:event.actor.id} : {}),objectRef:await this.#recordRef(e)});
    }
    const oldAudits = (maps(before,'audits').get(requestId)??[]) as AuditRecord[];
    const audits = (maps(after,'audits').get(requestId)??[]) as AuditRecord[];
    if (!same(audits.slice(0,oldAudits.length),oldAudits)) throw new StorageError('AUDIT_OVERWRITE');
    for (const a of audits.slice(oldAudits.length)) put({pk:pk(requestId),sk:this.#o.layout.auditSortKey(a),requestId,eventId:a.eventId,outcome:a.outcome,sequence:a.sequence,objectRef:await this.#recordRef(a)});
    if (command?.compilationResult && maps(after,'compilationResults').has(JSON.stringify([requestId,command.compilationResult.jobId])) && !maps(before,'compilationResults').has(JSON.stringify([requestId,command.compilationResult.jobId]))) {
      if (!this.#o.executionCondition) throw new StorageError('EXECUTION_CONDITION_REQUIRED');
      const condition = this.#o.executionCondition(command.compilationResult.execution);
      if (condition.TableName !== this.#o.tableName || condition.Key?.pk !== `JOB#${command.compilationResult.jobId}` || condition.Key?.sk !== 'META' || !condition.ConditionExpression) throw new StorageError('INVALID_EXECUTION_CONDITION');
      actions.push({ConditionCheck:condition});
    }
    if (command?.verificationResult && maps(after,'verificationResults').has(JSON.stringify([requestId,command.verificationResult.jobId])) && !maps(before,'verificationResults').has(JSON.stringify([requestId,command.verificationResult.jobId]))) {
      if (!this.#o.verificationCondition) throw new StorageError('VERIFICATION_CONDITION_REQUIRED');
      const condition = this.#o.verificationCondition(command.verificationResult.execution);
      if (condition.TableName !== this.#o.tableName || condition.Key?.pk !== `JOB#${command.verificationResult.jobId}` || condition.Key?.sk !== 'META' || !condition.ConditionExpression) throw new StorageError('INVALID_VERIFICATION_CONDITION');
      actions.push({ConditionCheck:condition});
    }
    const keys=actions.map(a=>canonicalizeJson(a.Put?.Item?{pk:a.Put.Item.pk,sk:a.Put.Item.sk}:a.ConditionCheck?.Key??a.Update?.Key));
    if (new Set(keys).size!==keys.length || actions.length>100 || Buffer.byteLength(JSON.stringify(actions))>3*1024*1024) throw new StorageError('DYNAMODB_TRANSACTION_LIMIT');
    return actions;
  }
  async #mutate(requestId: string, operation: (p: InMemoryOrchestratorStore)=>Promise<import('./requests.ts').ApplyResult>, command?: ApplyCommand) {
    for(let retry=0;retry<5;retry++) {
      const {meta,planner}=await this.#load(requestId), before=planner.exportRepositoryImage();
      const result=await operation(planner), after=planner.exportRepositoryImage();
      if(same(before,after)) return result; // same attempt's result was already durable
      const actions=await this.#transaction(requestId,before,after,meta,command);
      this.#o.testBeforeTransaction?.(actions);
      try { await this.#o.client.send(new TransactWriteCommand({TransactItems:actions})); return result; }
      catch(error) {
        const e=error as {name?:string;CancellationReasons?:{Code?:string}[]};
        if(e.name==='TransactionCanceledException' && command?.compilationResult && e.CancellationReasons?.some((r,i)=>r.Code==='ConditionalCheckFailed' && actions[i]?.ConditionCheck?.Key?.pk===`JOB#${command.compilationResult!.jobId}` && actions[i]?.ConditionCheck?.Key?.sk==='META')) {
          // Reload and durably audit the stale attempt, without retrying an authorized transition.
          command.preconditionFailure='STALE_JOB_ATTEMPT';delete command.compilationResult;
          if(command.compilationAttempt)command.compilationAttempt.reason='STALE_JOB_ATTEMPT';
          continue;
        }
        if(e.name==='TransactionCanceledException' && command?.verificationResult && e.CancellationReasons?.some((r,i)=>r.Code==='ConditionalCheckFailed' && actions[i]?.ConditionCheck?.Key?.pk===`JOB#${command.verificationResult!.jobId}` && actions[i]?.ConditionCheck?.Key?.sk==='META')) {
          command.preconditionFailure='STALE_JOB_ATTEMPT';delete command.verificationResult;
          if(command.verificationAttempt)command.verificationAttempt.reason='STALE_JOB_ATTEMPT';
          continue;
        }
        if(e.name==='TransactionCanceledException' && e.CancellationReasons?.some(r=>['ConditionalCheckFailed','TransactionConflict'].includes(r.Code??''))) continue;
        throw error;
      }
    }
    throw new StorageError('DURABLE_CONFLICT');
  }
  apply(command:ApplyCommand,principal:unknown) { const copy=structuredClone(command);return this.#mutate(copy.requestId,p=>p.apply(copy,principal),copy); }
  authorizeChecker(input:AuthorizeCheckerInput,principal:unknown) { const copy=structuredClone(input);return this.#mutate(copy.requestId,p=>p.authorizeChecker(copy,principal)); }
  recordJobDelivery(input:JobDeliveryAttempt,principal:unknown) { const copy=structuredClone(input);return this.#mutate(copy.requestId,p=>p.recordJobDelivery(copy,principal)); }
  async getWorkflow(id:string){return (await this.#load(id)).planner.getWorkflow(id);}
  async getSnapshot(ref:Parameters<InMemoryOrchestratorStore['getSnapshot']>[0]){return (await this.#load(ref.requestId)).planner.getSnapshot(ref);}
  async listSnapshots(id:string){return (await this.#load(id)).planner.listSnapshots(id);}
  async getReceipt(id:string,event:string){return (await this.#load(id)).planner.getReceipt(id,event);}
  async listEvidence(id:string){return (await this.#load(id)).planner.listEvidence(id);}
  async listAudit(id:string){return (await this.#load(id)).planner.listAudit(id);}
  async getJob(id:string,job:string){return (await this.#load(id)).planner.getJob(id,job);}
  async listJobs(id:string){return (await this.#load(id)).planner.listJobs(id);}
  async getDraftingResult(id:string,job:string){return (await this.#load(id)).planner.getDraftingResult(id,job);}
  async getCheckerInvocation(id:string,invocation:string){return (await this.#load(id)).planner.getCheckerInvocation(id,invocation);}
  async getCheckerReport(id:string,report:string){return (await this.#load(id)).planner.getCheckerReport(id,report);}
  async getCompilationJob(id:string,job:string){return (await this.#load(id)).planner.getCompilationJob(id,job);}
  async listCompilationJobs(id:string){return (await this.#load(id)).planner.listCompilationJobs(id);}
  async getCompilationOutbox(id:string,job:string){return (await this.#load(id)).planner.getCompilationOutbox(id,job);}
  async getCompilationResult(id:string,job:string){return (await this.#load(id)).planner.getCompilationResult(id,job);}
  async getVerifyBuildJob(id:string,job:string){return (await this.#load(id)).planner.getVerifyBuildJob(id,job);}
  async listVerifyBuildJobs(id:string){return (await this.#load(id)).planner.listVerifyBuildJobs(id);}
  async getVerifyBuildOutbox(id:string,job:string){return (await this.#load(id)).planner.getVerifyBuildOutbox(id,job);}
  async getVerificationResult(id:string,job:string){return (await this.#load(id)).planner.getVerificationResult(id,job);}
  async listReviewCandidates(status:WorkflowStatus) {
    const index=this.#o.layout.reviewerIndex, ids=new Set<string>();
    const partition=index.partitionValue(status);if(partition===null)return []; let start:Record<string,unknown>|undefined;
    do {
      const page=await this.#o.client.send(new QueryCommand({TableName:this.#o.tableName,IndexName:index.name,
        KeyConditionExpression:'#p = :p',ExpressionAttributeNames:{'#p':index.partitionAttribute},ExpressionAttributeValues:{':p':partition},ExclusiveStartKey:start}));
      for(const item of page.Items??[]) if(typeof item.requestId==='string') ids.add(item.requestId);
      start=page.LastEvaluatedKey;
    } while(start);
    // GSIs are discovery only; current strong reads plus ReviewService enforce access/evidence.
    const current=[]; for(const id of ids) if((await this.getWorkflow(id))?.status===status) current.push(id);
    return current.sort();
  }
}
