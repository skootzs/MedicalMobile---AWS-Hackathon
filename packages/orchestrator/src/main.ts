/**
 * Runnable entry point for the orchestrator.
 *
 *   MODE=local  -> real DynamoDB adapter against DynamoDB Local + durable local
 *                  object provider, with the LOCAL/DEMO identity provider so the
 *                  existing workflow can be demonstrated end to end.
 *   MODE=aws    -> real DynamoDB, real immutable S3 object storage, and real
 *                  verified Cognito (access-token) authentication. No in-memory
 *                  fallback, no local disk, no demo identities. Startup fails
 *                  closed on any missing/invalid config.
 *
 * Start:  npm start           (reads env; see README / .env for keys)
 * Stop:   Ctrl-C / SIGTERM    (graceful shutdown)
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from './config.ts';
import { bootstrap } from './bootstrap.ts';
import { createDemoIdentity } from './demo-identity.ts';
import { pollJobEventsOnce } from './job-events.ts';

async function run(): Promise<void> {
  const config = loadConfig();

  // Local/demo identity is wired ONLY for MODE=local. AWS mode receives no
  // identity here, so the bootstrap uses verified-Cognito (fail-closed) auth.
  const server = bootstrap({
    config,
    ...(config.mode === 'local' ? { identity: createDemoIdentity() } : {}),
  });

  let stopped = false;
  const shutdown = async (signal: string) => {
    stopped = true;
    process.stdout.write(`\n[orchestrator] received ${signal}, shutting down...\n`);
    try {
      await server.close();
      process.exit(0);
    } catch (error) {
      process.stderr.write(`[orchestrator] error during shutdown: ${(error as Error).message}\n`);
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    const address = await server.app.listen({ host: config.host, port: config.port });
    process.stdout.write(`[orchestrator] mode=${config.mode} listening on ${address}\n`);
    const jobEventsUrl = process.env.JOB_EVENTS_QUEUE_URL?.trim();
    if (config.mode === 'aws' && jobEventsUrl) {
      const sqs = new SQSClient({ region: config.region });
      const document = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));
      process.stdout.write('[orchestrator] consuming job-events\n');
      void (async () => {
        while (!stopped) {
          try {
            await pollJobEventsOnce({
              queueUrl: jobEventsUrl,
              sqs,
              reconciler: server.services.reconciler,
              async jobType(jobId) {
                const row = await document.send(new GetCommand({ TableName: config.ddbTable, Key: { pk: `JOB#${jobId}`, sk: 'META' }, ConsistentRead: true }));
                return typeof row.Item?.jobType === 'string' ? row.Item.jobType : null;
              },
              log: (message, detail) => process.stdout.write(`[orchestrator] ${message}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}\n`),
            });
          } catch (error) {
            process.stderr.write(`[orchestrator] job-events: ${(error as Error).message}\n`);
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
      })();
    }
    if (config.mode === 'local') {
      process.stdout.write('[orchestrator] LOCAL DEMO identities active (not production auth).\n');
    } else {
      process.stdout.write('[orchestrator] AWS mode: protected endpoints require a verified Cognito access token.\n');
    }
  } catch (error) {
    process.stderr.write(`[orchestrator] failed to start: ${(error as Error).message}\n`);
    await server.close().catch(() => {});
    process.exit(1);
  }
}

run().catch((error) => {
  process.stderr.write(`[orchestrator] fatal: ${(error as Error).message}\n`);
  process.exit(1);
});
