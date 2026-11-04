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
import { S3Client } from '@aws-sdk/client-s3';
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
import { S3ObjectStore } from './storage/s3-objects.ts';
import { r7Layout } from './storage/r7-layout.ts';
import type { StoreDependencies, OrchestratorStore } from './storage/requests.ts';
import { resolveCognitoActor, createCognitoAuthentication, cognitoCanAccessRequest } from './cognito-auth.ts';
import type { TokenVerifier } from './cognito-auth.ts';
import type { AuthenticationBoundary } from './auth.ts';
import type { Actor } from './workflow.ts';
import type { OrchestratorConfig, AwsConfig } from './config.ts';

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
  /**
   * Test seam (AWS mode only): inject a Cognito token verifier with a
   * pre-hydrated JWKS so real signature verification runs offline. In
   * production this is omitted and the verifier fetches the pool's JWKS.
   */
  cognitoVerifier?: TokenVerifier;
  now?: () => string;
}

export interface BootstrappedServer {
  app: FastifyInstance;
  config: OrchestratorConfig;
  /** Closes the Fastify app and destroys any client this bootstrap created. */
  close(): Promise<void>;
}

/**
 * AWS-mode identity: verified Cognito claims only, with authoritative
 * request-level access backed by the real store's workflow state. Built AFTER
 * the store so canAccessRequest can read ownership/review status.
 */
function awsIdentity(config: AwsConfig, store: OrchestratorStore, verifier?: TokenVerifier): IdentityProvider {
  const getWorkflow = (requestId: string) => store.getWorkflow(requestId);
  const authentication = createCognitoAuthentication({
    userPoolId: config.cognito.userPoolId,
    clientId: config.cognito.clientId,
    tokenUse: 'access',
    getWorkflow,
    ...(verifier ? { verifier } : {}),
  });
  const access = (principal: unknown, requestId: string) => cognitoCanAccessRequest(getWorkflow, principal, requestId);
  return {
    resolveActor: (principal) => resolveCognitoActor(principal),
    authentication,
    canAccessRequestForReview: (principal, requestId) => access(principal, requestId),
    canAccessRequestContext: (principal, requestId) => access(principal, requestId),
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

function buildObjects(config: OrchestratorConfig): { objects: DurableObjects; s3?: S3Client } {
  if (config.mode === 'local') return { objects: new LocalObjectStore(config.objectDirectory) };
  const s3 = new S3Client({ region: config.region });
  return { objects: new S3ObjectStore({ client: s3, bucket: config.artifactBucket }), s3 };
}

/**
 * Assemble the server. Does not call listen(); the caller (main.ts) owns the
 * socket lifecycle. Throws on any misconfiguration — never boots half-wired.
 */
export function bootstrap(options: BootstrapOptions): BootstrappedServer {
  const { config } = options;

  // Local mode requires an explicit (local/test-only) identity up front and
  // fails closed without one. AWS mode builds its identity AFTER the store.
  if (config.mode === 'local' && !options.identity) {
    throw new Error('Local mode requires an explicit identity provider (local/test-only).');
  }

  let createdClient: DynamoDBClient | undefined;
  let document = options.documentClient;
  if (!document) {
    const built = buildDocumentClient(config);
    document = built.document;
    createdClient = built.raw;
  }
  let createdS3: S3Client | undefined;
  let objects = options.objects;
  if (!objects) {
    const built = buildObjects(config);
    objects = built.objects;
    createdS3 = built.s3;
  }

  // The actor resolver never depends on the store, so the store can be built
  // with the mode-appropriate resolver before AWS identity (which does need
  // the store for authoritative request access) is assembled.
  const resolveActor: StoreDependencies['resolveActor'] = config.mode === 'aws'
    ? (principal) => resolveCognitoActor(principal)
    : options.identity!.resolveActor;

  const store = new DynamoOrchestratorStore({
    client: document,
    tableName: config.ddbTable,
    objects,
    layout: r7Layout,
    resolveActor,
    validateSnapshot: provisionalSnapshotValidator,
    ...(options.now ? { now: options.now } : {}),
  });

  const identity: IdentityProvider = config.mode === 'aws'
    ? awsIdentity(config, store, options.cognitoVerifier)
    : options.identity!;

  const canAccessReview = identity.canAccessRequestForReview
    ?? ((principal: unknown, requestId: string) => identity.canAccessRequestContext(principal, requestId));

  const approvals = new ApprovalService({ store, resolveActor: identity.resolveActor });
  const requests = new RequestService({ store, resolveActor: identity.resolveActor, validateSnapshot: provisionalSnapshotValidator });
  const reviews = new ReviewService({ store, candidates: store, resolveActor: identity.resolveActor, canAccessRequest: canAccessReview });
  const routing = new RoutingService({ store, resolveActor: identity.resolveActor, canAccessRequest: identity.canAccessRequestContext });

  const app = buildServer({ store, approvals, requests, reviews, routing, authentication: identity.authentication, health: { mode: config.mode } });

  return {
    app,
    config,
    async close() {
      try { await app.close(); } finally { createdClient?.destroy(); createdS3?.destroy(); }
    },
  };
}

export type { Actor };
