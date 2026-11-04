/**
 * Runnable entry point for the orchestrator.
 *
 *   MODE=local  -> real DynamoDB adapter against DynamoDB Local + durable local
 *                  object provider, with the LOCAL/DEMO identity provider so the
 *                  existing workflow can be demonstrated end to end.
 *   MODE=aws    -> real DynamoDB + (pending) S3 and verified Cognito identity.
 *                  Boots fail-closed: S3 and JWT verification are later
 *                  milestones, so AWS mode currently refuses to start rather
 *                  than fabricate cloud writes or trust an unverified token.
 *
 * Start:  npm start           (reads env; see README / .env for keys)
 * Stop:   Ctrl-C / SIGTERM    (graceful shutdown)
 */
import { loadConfig } from './config.ts';
import { bootstrap } from './bootstrap.ts';
import { createDemoIdentity } from './demo-identity.ts';

async function run(): Promise<void> {
  const config = loadConfig();

  // Local/demo identity is wired ONLY for MODE=local. AWS mode receives no
  // identity here, so the bootstrap uses verified-Cognito (fail-closed) auth.
  const server = bootstrap({
    config,
    ...(config.mode === 'local' ? { identity: createDemoIdentity() } : {}),
  });

  const shutdown = async (signal: string) => {
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
    if (config.mode === 'local') {
      process.stdout.write('[orchestrator] LOCAL DEMO identities active (not production auth).\n');
    } else {
      process.stdout.write('[orchestrator] AWS mode: protected endpoints require verified Cognito (pending JWT verification).\n');
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
