import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { JobResult } from './generated/handoffs.ts';

export type TakeOutcome =
  | { kind: 'TAKEN'; attempt: number }
  | { kind: 'TERMINAL' }
  | { kind: 'LEASED'; leaseUntil: number }
  | { kind: 'MISSING' }
  | { kind: 'DUPLICATE_DELIVERY' };

export interface TakeInput {
  jobId: string;
  requestId: string;
  messageId: string;
  receiveCount: number;
  workerId: string;
  leaseSeconds: number;
}

export interface LeaseRef {
  jobId: string;
  requestId: string;
  workerId: string;
  attempt: number;
}

export interface Approval {
  decision?: string;
  logicModelHash?: string;
  superseded?: boolean;
  status?: string;
}

function jobKey(jobId: string) {
  return { pk: `JOB#${jobId}`, sk: 'META' };
}

function isConditionFailure(err: unknown): boolean {
  return err instanceof TransactionCanceledException
    && (err.CancellationReasons ?? []).some((reason) => reason.Code === 'ConditionalCheckFailed');
}

export class JobStore {
  readonly #client: DynamoDBDocumentClient;
  readonly #table: string;
  readonly #now: () => number;

  constructor(client: DynamoDBDocumentClient, table: string, now: () => number = Date.now) {
    this.#client = client;
    this.#table = table;
    this.#now = now;
  }

  #audit(requestId: string, event: string, detail: Record<string, unknown>) {
    const ts = new Date(this.#now()).toISOString();
    const eventId = randomUUID();
    return {
      Put: {
        TableName: this.#table,
        Item: { pk: `REQ#${requestId}`, sk: `AUDIT#${ts}#${eventId}`, event, eventId, ts, ...detail },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    };
  }

  async getJob(jobId: string): Promise<Record<string, unknown> | undefined> {
    const found = await this.#client.send(new GetCommand({ TableName: this.#table, Key: jobKey(jobId), ConsistentRead: true }));
    return found.Item;
  }

  // The receipt is keyed by message AND receive count: SQS redelivers a retried or
  // crashed job under the same MessageId, so keying on the id alone would reject the
  // takeover. Exclusivity comes from the META condition, not from the receipt.
  async take(input: TakeInput): Promise<TakeOutcome> {
    const now = this.#now();
    try {
      await this.#client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.#table,
              Item: {
                pk: `JOB#${input.jobId}`,
                sk: `RECEIPT#${input.messageId}#${input.receiveCount}`,
                messageId: input.messageId,
                receiveCount: input.receiveCount,
                workerId: input.workerId,
                receivedAt: new Date(now).toISOString(),
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: this.#table,
              Key: jobKey(input.jobId),
              UpdateExpression: 'SET #status = :running, leaseOwner = :owner, leaseUntil = :until, attempt = if_not_exists(attempt, :zero) + :one',
              ConditionExpression: 'attribute_exists(pk) AND (#status = :pending OR (#status = :running AND leaseUntil < :now))',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':running': 'RUNNING',
                ':pending': 'PENDING',
                ':owner': input.workerId,
                ':until': now + input.leaseSeconds * 1000,
                ':zero': 0,
                ':one': 1,
                ':now': now,
              },
            },
          },
          this.#audit(input.requestId, 'job_started', { jobId: input.jobId, workerId: input.workerId, messageId: input.messageId }),
        ],
      }));
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
      const reasons = (err as TransactionCanceledException).CancellationReasons ?? [];
      if (reasons[1]?.Code !== 'ConditionalCheckFailed') return { kind: 'DUPLICATE_DELIVERY' };
      const job = await this.getJob(input.jobId);
      if (!job) return { kind: 'MISSING' };
      if (job.status === 'RUNNING') return { kind: 'LEASED', leaseUntil: Number(job.leaseUntil) };
      if (job.status === 'SUCCEEDED' || job.status === 'FAILED') return { kind: 'TERMINAL' };
      // A status this runner doesn't recognise must stay visible, never be acked away.
      throw new Error(`Job ${input.jobId} has unexpected status ${String(job.status)}`, { cause: err });
    }
    const job = await this.getJob(input.jobId);
    return { kind: 'TAKEN', attempt: Number(job?.attempt) };
  }

  // Returns false once the lease is lost, so the caller can stop the running stage.
  async heartbeat(lease: LeaseRef, leaseSeconds: number): Promise<boolean> {
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#table,
        Key: jobKey(lease.jobId),
        UpdateExpression: 'SET leaseUntil = :until',
        ConditionExpression: 'leaseOwner = :owner AND attempt = :attempt AND #status = :running',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':until': this.#now() + leaseSeconds * 1000,
          ':owner': lease.workerId,
          ':attempt': lease.attempt,
          ':running': 'RUNNING',
        },
      }));
      return true;
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }

  async releaseForRetry(lease: LeaseRef, errorCode: string, errorMessage: string): Promise<boolean> {
    return this.#transact([
      {
        Update: {
          TableName: this.#table,
          Key: jobKey(lease.jobId),
          UpdateExpression: 'SET #status = :pending, lastErrorCode = :code, lastErrorMessage = :message REMOVE leaseOwner, leaseUntil',
          ConditionExpression: 'leaseOwner = :owner AND attempt = :attempt AND #status = :running',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'PENDING',
            ':running': 'RUNNING',
            ':owner': lease.workerId,
            ':attempt': lease.attempt,
            ':code': errorCode,
            ':message': errorMessage,
          },
        },
      },
      this.#audit(lease.requestId, 'attempt_failed_retryable', { jobId: lease.jobId, attempt: lease.attempt, errorCode }),
    ]);
  }

  async commitResult(lease: LeaseRef, result: JobResult): Promise<boolean> {
    const names: Record<string, string> = { '#status': 'status' };
    const values: Record<string, unknown> = {
      ':running': 'RUNNING',
      ':owner': lease.workerId,
      ':attempt': lease.attempt,
    };
    const sets: string[] = [];
    Object.entries(result).forEach(([field, value], index) => {
      if (value === undefined || field === 'attempt' || field === 'jobId') return;
      names[`#f${index}`] = field;
      values[`:f${index}`] = value;
      sets.push(`#f${index} = :f${index}`);
    });
    // The lease fields go away below, and R2 needs to know which actor ran the job.
    values[':actor'] = lease.workerId;
    sets.push('runnerActorId = :actor');
    return this.#transact([
      {
        Update: {
          TableName: this.#table,
          Key: jobKey(lease.jobId),
          UpdateExpression: `SET ${sets.join(', ')} REMOVE leaseOwner, leaseUntil`,
          ConditionExpression: 'leaseOwner = :owner AND attempt = :attempt AND #status = :running',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
      },
      this.#audit(lease.requestId, result.status === 'SUCCEEDED' ? 'job_succeeded' : 'job_failed', {
        jobId: lease.jobId,
        attempt: lease.attempt,
        errorCode: result.errorCode,
      }),
    ]);
  }

  // For payloads that fail validation before any lease exists. Only a PENDING job can
  // be failed this way, so a garbled message can't kill a job another worker is running.
  async failUnleased(jobId: string, requestId: string | undefined, runnerActorId: string, result: Omit<JobResult, 'attempt'> & { attempt: number }): Promise<boolean> {
    const names: Record<string, string> = { '#status': 'status' };
    const values: Record<string, unknown> = { ':pending': 'PENDING', ':actor': runnerActorId };
    const sets: string[] = ['runnerActorId = :actor'];
    Object.entries(result).forEach(([field, value], index) => {
      if (value === undefined || field === 'jobId') return;
      names[`#f${index}`] = field;
      values[`:f${index}`] = value;
      sets.push(`#f${index} = :f${index}`);
    });
    const update = {
      Update: {
        TableName: this.#table,
        Key: jobKey(jobId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: '#status = :pending',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    };
    const job = requestId ? undefined : await this.getJob(jobId);
    const auditRequestId = requestId ?? (job?.requestId as string | undefined);
    return this.#transact(auditRequestId
      ? [update, this.#audit(auditRequestId, 'job_failed', { jobId, errorCode: result.errorCode })]
      : [update]);
  }

  async getApproval(requestId: string, approvalId: string): Promise<Approval | undefined> {
    const found = await this.#client.send(new GetCommand({
      TableName: this.#table,
      Key: { pk: `REQ#${requestId}`, sk: `APPROVAL#${approvalId}` },
      ConsistentRead: true,
    }));
    return found.Item as Approval | undefined;
  }

  async #transact(TransactItems: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>): Promise<boolean> {
    try {
      await this.#client.send(new TransactWriteCommand({ TransactItems }));
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }
}
