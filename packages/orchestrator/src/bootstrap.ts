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
import { DraftingHandoffService } from './jobs.ts';
import { DraftingCallbackService } from './callbacks.ts';
import { CheckerResultService } from './checkers.ts';
import { CompilationHandoffService } from './compilations.ts';
import { CompilationResultService } from './compilation-results.ts';
import { VerifyBuildHandoffService } from './verify-builds.ts';
import { VerificationResultService } from './verification-results.ts';
import { JobCompletionReconciler } from './reconciler.ts';
import { DurableLogicModelReferences } from './storage/durable-objects.ts';
import { r7CompilationExecutionSource, r7VerificationExecutionSource, r7CompilationCondition, r7VerificationCondition } from './r7-job-record.ts';
import { buildServer } from './server.ts';
import { provisionalSnapshotValidator } from './snapshots.ts';
import { DynamoOrchestratorStore } from './storage/dynamodb.ts';
import type { DynamoStoreOptions } from './storage/dynamodb.ts';
import type { DurableObjects } from './storage/durable-objects.ts';
import { LocalObjectStore } from './storage/local-objects.ts';
import { S3ObjectStore } from './storage/s3-objects.ts';
import { r7Layout } from './storage/r7-layout.ts';
import type { StoreDependencies, OrchestratorStore } from './storage/requests.ts';
import { resolveCognitoActor, createCognitoAuthentication, cognitoCanAccessRequest } from './cognito-auth.ts';
import type { TokenVerifier } from './cognito-auth.ts';
import type { AuthenticationBoundary } from './auth.ts';
import type { Actor } from './workflow.ts';
import type { CheckerTarget } from './checker-contracts.ts';
import type { CompilationArtifactVerifier } from './compilation-result-contracts.ts';
import type { LogicValidationBoundary } from './callback-contracts.ts';
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
  /**
   * Machine-to-machine trust policies for the R3/R4/R5/R6 ingestion services.
   * These are teammate-owned boundaries; the services FAIL CLOSED when a
   * required one is absent (e.g. no R4 validation => drafting callback blocked,
   * no artifact verifier => compile result blocked). They are injected rather
   * than defaulted so the runtime never fabricates a trusted worker or a
   * passing validation.
   */
  workers?: WorkerPolicies;
  now?: () => string;
}

/** Teammate-owned trust boundaries the M2M ingestion services require. */
export interface WorkerPolicies {
  /**
   * Resolves a verified R3/R4/R5/R6 SERVICE principal to a worker-role actor
   * (DRAFTER/CHECKER/COMPILER/VERIFIER). This is DISTINCT from the human Cognito
   * resolver: R7's runner and the AI workers authenticate with their own service
   * identities, never a browser Cognito session, and no Cognito group grants a
   * worker role. When absent, M2M ingestion uses the human resolver, which maps
   * no worker role, so every worker result fails closed (UNAUTHORIZED / WRONG_ROLE).
   */
  resolveServiceActor?: StoreDependencies['resolveActor'];
  /** Access policy for service principals at the M2M boundary (defaults to deny). */
  canServiceAccessRequest?(principal: unknown, requestId: string): boolean | Promise<boolean>;
  /** Maps a verified R7 runner identity for COMPILE_LOGIC results. */
  authorizeCompilationRunner?(actor: Readonly<Actor>, jobId: string): boolean | Promise<boolean>;
  /** Maps a verified R7 runner identity for VERIFY_BUILD results. */
  authorizeVerificationRunner?(actor: Readonly<Actor>, jobId: string): boolean | Promise<boolean>;
  /** R4 validation boundary for the drafting (LOGIC_PROPOSED) callback. */
  draftingValidation?: LogicValidationBoundary;
  /** R5 compiled-artifact verifier for COMPILE_LOGIC results. */
  compilationArtifacts?: CompilationArtifactVerifier;
  /** R4 checker target identity for checker-result ingestion. */
  checkerTarget?: CheckerTarget;
}

/** The wired R2 services, exposed so the R7 queue consumer / orchestration can drive them. */
export interface OrchestratorServices {
  draftingHandoff: DraftingHandoffService;
  draftingCallback: DraftingCallbackService | null;
  checkerResults: CheckerResultService | null;
  compilationHandoff: CompilationHandoffService;
  compilationResults: CompilationResultService;
  verifyBuildHandoff: VerifyBuildHandoffService;
  verificationResults: VerificationResultService;
  /** The entry point R7's job-events consumer / poller invokes per terminal job. */
  reconciler: JobCompletionReconciler;
}

export interface BootstrappedServer {
  app: FastifyInstance;
  config: OrchestratorConfig;
  /** The wired machine-to-machine services (handoffs, ingestion, reconciler). */
  services: OrchestratorServices;
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

  // ---------- Machine-to-machine ingestion services ----------
  const canAccess = identity.canAccessRequestContext;
  const workers = options.workers ?? {};
  // Handoffs are ORCHESTRATOR-driven and use the human (Cognito) resolver.
  // Result/callback ingestion is SERVICE-driven: it resolves worker identities
  // through a distinct service-actor resolver (never the human Cognito path).
  // Absent a service resolver, worker ingestion resolves no worker role and
  // fails closed.
  const serviceResolver: StoreDependencies['resolveActor'] = workers.resolveServiceActor ?? identity.resolveActor;
  const canServiceAccess = workers.canServiceAccessRequest ?? (() => false);

  // Handoff services (emit job intents, no runner/worker execution).
  const draftingHandoff = new DraftingHandoffService({ store, resolveActor: identity.resolveActor, canAccessRequest: canAccess });
  const compilationHandoff = new CompilationHandoffService({ store, resolveActor: identity.resolveActor, canAccessRequest: canAccess,
    snapshotReferences: new DurableLogicModelReferences(objects) });
  const verifyBuildHandoff = new VerifyBuildHandoffService({ store, resolveActor: identity.resolveActor, canAccessRequest: canAccess });

  // Callback/result services. These read R7's authoritative JOB/META and require
  // teammate-owned trust policies; they fail closed when a required boundary is
  // absent. The store instances for compile/verify result ingestion carry the
  // R7 execution-condition so the DynamoDB transaction gates on the real attempt,
  // and use the SERVICE resolver so the store re-resolves the worker identity.
  const storeBase: Omit<DynamoStoreOptions, 'executionCondition' | 'verificationCondition' | 'testBeforeTransaction'> = {
    client: document, tableName: config.ddbTable, objects, layout: r7Layout, resolveActor: serviceResolver, validateSnapshot: provisionalSnapshotValidator, ...(options.now ? { now: options.now } : {}),
  };
  // A store that re-resolves the SERVICE identity inside apply() (worker roles),
  // used by all M2M ingestion so the atomic commit authorizes the worker, not a
  // human session. Compile/verify add the R7 execution condition on top.
  const serviceStore = new DynamoOrchestratorStore({ ...storeBase });
  const compileStore = new DynamoOrchestratorStore({ ...storeBase, executionCondition: r7CompilationCondition(config.ddbTable) });
  const verifyStore = new DynamoOrchestratorStore({ ...storeBase, verificationCondition: r7VerificationCondition(config.ddbTable) });

  const compileSrc = r7CompilationExecutionSource(document, config.ddbTable, compileStore);
  const verifySrc = r7VerificationExecutionSource(document, config.ddbTable, verifyStore);

  const draftingCallback = workers.draftingValidation
    ? new DraftingCallbackService({ store: serviceStore, resolveActor: serviceResolver, canAccessRequest: canServiceAccess, validation: workers.draftingValidation })
    : null;
  const checkerResults = workers.checkerTarget
    ? new CheckerResultService({ store: serviceStore, resolveActor: serviceResolver, canAccessRequest: canServiceAccess, checker: workers.checkerTarget })
    : null;
  const compilationResults = new CompilationResultService({
    store: compileStore, resolveActor: serviceResolver, canAccessRequest: canServiceAccess, executions: compileSrc,
    authorizeRunner: (actor, job) => workers.authorizeCompilationRunner?.(actor, job.jobId) ?? false, artifacts: workers.compilationArtifacts,
  });
  const verificationResults = new VerificationResultService({
    store: verifyStore, resolveActor: serviceResolver, canAccessRequest: canServiceAccess, executions: verifySrc,
    authorizeRunner: (actor, job) => workers.authorizeVerificationRunner?.(actor, job.jobId) ?? false, objects,
  });
  const reconciler = new JobCompletionReconciler({ store, compilation: compilationResults, verification: verificationResults });

  const services: OrchestratorServices = {
    draftingHandoff, draftingCallback, checkerResults,
    compilationHandoff, compilationResults, verifyBuildHandoff, verificationResults, reconciler,
  };

  const app = buildServer({ store, approvals, requests, reviews, routing, authentication: identity.authentication, health: { mode: config.mode } });

  return {
    app,
    config,
    services,
    async close() {
      try { await app.close(); } finally { createdClient?.destroy(); createdS3?.destroy(); }
    },
  };
}

export type { Actor };
