import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { dockerStages } from '../launch-build.ts';
import { loadConfig } from './config.ts';
import { documentClient } from './ddb.ts';
import { JobStore } from './store.ts';
import { Worker, type Artifacts, type Queue } from './worker.ts';

const config = loadConfig();
const sqs = new SQSClient({ region: config.region });
const s3 = new S3Client({ region: config.region });

const queue: Queue = {
  async delete(message) {
    await sqs.send(new DeleteMessageCommand({ QueueUrl: config.jobsQueueUrl, ReceiptHandle: message.receiptHandle }));
  },
  async setVisibility(message, seconds) {
    await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: config.jobsQueueUrl, ReceiptHandle: message.receiptHandle, VisibilityTimeout: seconds }));
  },
};

const artifacts: Artifacts = {
  async get(uri) {
    const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
    if (!match) throw new Error(`Not an s3 uri: ${uri}`);
    const found = await s3.send(new GetObjectCommand({ Bucket: match[1], Key: match[2] }));
    return Buffer.from(await found.Body!.transformToByteArray());
  },
  async put(key, body) {
    const stored = await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body }));
    return { uri: `s3://${config.bucket}/${key}`, ...(stored.VersionId ? { versionId: stored.VersionId } : {}) };
  },
};

const log = (level: 'info' | 'error', message: string, detail?: unknown): void => {
  console.log(`level=${level} ${message}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
};

const worker = new Worker({
  config,
  store: new JobStore(documentClient(new DynamoDBClient({ region: config.region })), config.table),
  queue,
  artifacts,
  stages: dockerStages,
  log,
});

let running = true;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { running = false; });

log('info', 'runner started', { workerId: config.workerId });
while (running) {
  try {
    const received = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: config.jobsQueueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }));
    for (const message of received.Messages ?? []) {
      const outcome = await worker.handle({
        messageId: message.MessageId!,
        receiptHandle: message.ReceiptHandle!,
        receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
        body: message.Body ?? '',
      });
      log('info', 'message handled', { messageId: message.MessageId, outcome });
    }
  } catch (err) {
    log('error', 'runner loop error', { error: String(err) });
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
log('info', 'runner stopped');
