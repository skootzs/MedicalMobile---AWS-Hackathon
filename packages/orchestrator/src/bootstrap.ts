/**
 * Production composition root for the orchestrator.
 *
 * Builds the real DynamoDB-backed store, the existing request/review/approval/
 * routing services, and the Fastify server (via buildServer, so routes and auth
 * hooks are never duplicated). It NEVER falls back to in-memory storage, and in
 * AWS mode it NEVER uses a demo identity: authentication is the fail-closed
 * pending Cognito boundary until JWT verification lands.
 *
 * Local mode still uses the real DynamoDB adapter + durable object provider;
 * the only thing it relaxes is the identity source, which must be supplied
 * explicitly by local/test-only code (see createDemoIdentity in demo-identity).
 * There is no built-in identity default here, so a misconfigured local boot
 * also fails closed rather than inventing a user.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { FastifyInstance } from 'fastify';
import { ApprovalService } from './approvals.ts';
import { RequestService } from './requests.ts';
import { ReviewService } from './reviews.ts';
import { RoutingService } from './routing-service.ts';
import { buildServer } from './server.ts';
import { provisionalSnapshotValidator } from './snapshots.ts';
import { DynamoOrchestratorStore } from './storage/dynamodb.ts';
import type { DurableObjects } from './storage/durable-objects.ts';
import { LocalObjectStore } from './storage/local-objects.ts';
import { r7Layout } from './storage/r7-layout.ts';
import type { StoreDependencies } from './storage/requests.ts';
import { pendingCognitoAuthentication, resolveCognitoActor, cognitoCanAccessRequest } from './cognito-auth.ts';
import type { AuthenticationBoundary } from './auth.ts';
import type { Actor } from './workflow.ts';
import type { OrchestratorConfig } from './config.ts';

/**
 * Identity wiring the bootstrap cannot safely default. AWS mode ignores any
 * supplied identity and uses verified Cognito claims; local mode REQUIRES an
 * explicit (local/test-only) identity provider and fails closed without one.
 */
export interface IdentityProvider {
  resolveActor: StoreDependencies['resolveActor'];
  authentication: AuthenticationBoundary;
  /** 3-arg review access variant; defaults to the 2-arg form ignoring category. */
  canAccessRequestForReview?(principal: unknown, requestId: string, category: string): boolean | Promise<boolean>;
  /** 2-arg form the store/services use once a principal is unwrapped to context. */
  canAccessRequestContext(principal: unknown, requestId: string): boolean | Promise<boolean>;
}

export interface BootstrapOptions {
  config: OrchestratorConfig;
  /** Local/test-only identity. REQUIRED in local mode; ignored in AWS mode. */
  identity?: IdentityProvider;
  /** Test seam: inject a preconstructed document client (e.g. DynamoDB Local). */
  documentClient?: DynamoDBDocumentClient;
  /** Test seam: inject the durable object provider. */
  objects?: DurableObjects;
  now?: () => string;
}

export interface BootstrappedServer {
  app: FastifyInstance;
  config: OrchestratorConfig;
  /** Closes the Fastify app and destroys any client this bootstrap created. */
  close(): Promise<void>;
}

/** AWS-mode identity: verified Cognito claims only; fail closed until JWT verify. */
function awsIdentity(): IdentityProvider {
  return {
    resolveActor: (principal) => resolveCognitoActor(principal),
    authentication: pendingCognitoAuthentication,
    canAccessRequestForReview: (principal) => resolveCognitoActor(principal) !== null,
    canAccessRequestContext: (principal) => resolveCognitoActor(principal) !== null,
  };
}

function buildDocumentClient(config: OrchestratorConfig): { document: DynamoDBDocumentClient; raw: DynamoDBClient } {
  const raw = config.mode === 'aws'
    ? new DynamoDBClient({ region: config.region })
    : new DynamoDBClient({
        endpoint: config.dynamoEndpoint,
        region: 'local',
        // Loopback DynamoDB Local requires non-empty (ignored) credentials.
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      });
  return { document: DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: false } }), raw };
}

function buildObjects(config: OrchestratorConfig): DurableObjects {
  if (config.mode === 'local') return new LocalObjectStore(config.objectDirectory);
  // AWS mode object storage (S3) is a later milestone. Fail closed rather than
  // fabricate successful cloud writes.
  throw new Error('AWS-mode durable object storage (S3) is not implemented yet; run MODE=local for the demo.');
}

/**
 * Assemble the server. Does not call listen(); the caller (main.ts) owns the
 * socket lifecycle. Throws on any misconfiguration — never boots half-wired.
 */
export function bootstrap(options: BootstrapOptions): BootstrappedServer {
  const { config } = options;

  const identity: IdentityProvider = config.mode === 'aws'
    ? awsIdentity()
    : (() => {
        if (!options.identity) throw new Error('Local mode requires an explicit identity provider (local/test-only).');
        return options.identity;
      })();

  let createdClient: DynamoDBClient | undefined;
  let document = options.documentClient;
  if (!document) {
    const built = buildDocumentClient(config);
    document = built.document;
    createdClient = built.raw;
  }
  const objects = options.objects ?? buildObjects(config);

  const storeDeps: Pick<StoreDependencies, 'resolveActor' | 'validateSnapshot'> & { now?: () => string } = {
    resolveActor: identity.resolveActor,
    validateSnapshot: provisionalSnapshotValidator,
    ...(options.now ? { now: options.now } : {}),
  };
  const store = new DynamoOrchestratorStore({
    client: document,
    tableName: config.ddbTable,
    objects,
    layout: r7Layout,
    ...storeDeps,
  });

  const canAccessReview = identity.canAccessRequestForReview
    ?? ((principal: unknown, requestId: string) => identity.canAccessRequestContext(principal, requestId));

  const approvals = new ApprovalService({ store, resolveActor: identity.resolveActor });
  const requests = new RequestService({ store, resolveActor: identity.resolveActor, validateSnapshot: provisionalSnapshotValidator });
  const reviews = new ReviewService({ store, candidates: store, resolveActor: identity.resolveActor, canAccessRequest: canAccessReview });
  const routing = new RoutingService({ store, resolveActor: identity.resolveActor, canAccessRequest: identity.canAccessRequestContext });

  const app = buildServer({ store, approvals, requests, reviews, routing, authentication: identity.authentication });

  return {
    app,
    config,
    async close() {
      try { await app.close(); } finally { createdClient?.destroy(); }
    },
  };
}

/** Re-export so AWS-mode identity can be inspected/tested without reaching in. */
export { awsIdentity };
export type { Actor };
