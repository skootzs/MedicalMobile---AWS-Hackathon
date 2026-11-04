// R2/R7 job delivery contract: payload and result types that cross the
// jobs queue, plus JSON Schema + Ajv validators for each. Every service
// validates what it receives against these schemas and fails closed.
//
// Full narrative contract (hash identities, key layout, lease/retry
// behavior): docs/job-delivery.md in the r7-infra branch.
//
// Confirmed with R4 (skootzs): this is the agreed home for these types.
import Ajv, { type JSONSchemaType, type ValidateFunction } from 'ajv';

export const CONTRACT_VERSION = '1.0.0';

export type JobType = 'DRAFT_LOGIC' | 'COMPILE_LOGIC' | 'VERIFY_BUILD';
export type CompileMode = 'preview' | 'approved';
export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

// From section 6/7: the coded failure reasons the runner can report.
export type JobErrorCode =
  | 'INVALID_PAYLOAD'
  | 'HASH_MISMATCH'
  | 'INPUT_HASH_MISMATCH'
  | 'APPROVAL_INVALID'
  | 'MODEL_REJECTED'
  | 'COMPILE_INFRA_ERROR'
  | 'CONVERT_FAILED'
  | 'VERIFY_ERROR'
  | 'TIMEOUT'
  | 'LEASE_EXPIRED'
  | 'DELIVERY_EXHAUSTED';

export interface JobPayload {
  contractVersion: typeof CONTRACT_VERSION;
  jobId: string;
  jobType: JobType;
  mode?: CompileMode; // COMPILE_LOGIC only
  requestId: string;
  revision: number;
  logicModelHash: string; // R2's hash of the canonical snapshot envelope, "sha256:<64 hex>"
  snapshotUri: string; // s3://.../snapshots/<logicModelHash>.json (the envelope)
  checkReportHash: string; // the compiler doesn't read this; the runner records it
  clinicalApprovalId: string | null; // required (non-null) when mode = 'approved'
  baselineHash?: string | null; // absent or null for first integration (compiler ignores it)
  createdBy: string;
  createdAt: string; // ISO
}

// Everything in JobPayload, plus the exact compiled artifact R2 authorized.
export interface VerifyBuildPayload extends JobPayload {
  jobType: 'VERIFY_BUILD';
  compileJobId: string;
  packageUri: string; // project.tgz from the accepted COMPILE_LOGIC result
  packageHash: string;
  compileArtifactHash: string;
  manifestHash: string;
}

export interface JobResult {
  contractVersion: typeof CONTRACT_VERSION;
  jobId: string;
  jobType: JobType;
  mode?: CompileMode;
  attempt: number;
  status: 'SUCCEEDED' | 'FAILED';
  logicModelHash: string;
  snapshotHash?: string; // from compile-manifest.json; must equal logicModelHash
  inputHash?: string; // from compile-manifest.json; must equal the runner's own hash of /in/logic.json
  compileArtifactHash?: string; // compile-manifest.json artifactHash
  templateHash?: string; // compile-manifest.json template.hash
  compileErrors?: { code: string; path: string; message: string }[]; // compiler exit 1 (stderr JSON)
  retryable?: boolean; // false for MODEL_REJECTED, true for infra errors
  manifestHash?: string;
  manifestUri?: string;
  packageHash?: string;
  packageUri?: string; // s3://.../builds/<logicModelHash>/<jobId>/attempt-<n>/project.tgz
  toolVersions: {
    compileImageDigest?: string;
    buildImageDigest?: string;
    compilerCommit?: string;
    verifierCommit?: string;
    chtConf?: string;
    modelId?: string;
  };
  startedAt: string;
  finishedAt: string;
  errorCode: JobErrorCode | null;
  errorMessage: string | null;
  logUri?: string;
  // VERIFY_BUILD only:
  reportUri?: string;
  reportHash?: string;
  verificationPassed?: boolean; // copied from report.passed
  coverageComplete?: boolean; // copied from report.coverageComplete
  testedDirHash?: string; // copied from report (VerificationReport v2.0.0)
  reportVersion?: string; // e.g. "2.0.0"
}

// Thin; R2 reads the job item for details.
export interface JobEvent {
  contractVersion: typeof CONTRACT_VERSION;
  jobId: string;
  status: JobStatus;
  attempt: number;
}

// --- JSON Schemas (additionalProperties: false; every schema carries contractVersion) ---

const LOGIC_MODEL_HASH_PATTERN = '^[A-Za-z0-9:_-]{8,128}$';

const jobErrorCodeEnum: JobErrorCode[] = [
  'INVALID_PAYLOAD',
  'HASH_MISMATCH',
  'INPUT_HASH_MISMATCH',
  'APPROVAL_INVALID',
  'MODEL_REJECTED',
  'COMPILE_INFRA_ERROR',
  'CONVERT_FAILED',
  'VERIFY_ERROR',
  'TIMEOUT',
  'LEASE_EXPIRED',
  'DELIVERY_EXHAUSTED',
];

export const jobPayloadSchema: JSONSchemaType<JobPayload> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contractVersion: { const: CONTRACT_VERSION },
    jobId: { type: 'string', minLength: 1 },
    jobType: { type: 'string', enum: ['DRAFT_LOGIC', 'COMPILE_LOGIC', 'VERIFY_BUILD'] },
    mode: { type: 'string', enum: ['preview', 'approved'], nullable: true },
    requestId: { type: 'string', minLength: 1 },
    revision: { type: 'integer', minimum: 0 },
    logicModelHash: { type: 'string', pattern: LOGIC_MODEL_HASH_PATTERN },
    snapshotUri: { type: 'string', minLength: 1 },
    checkReportHash: { type: 'string', minLength: 1 },
    clinicalApprovalId: { type: 'string', nullable: true },
    baselineHash: { type: 'string', nullable: true },
    createdBy: { type: 'string', minLength: 1 },
    createdAt: { type: 'string', minLength: 1 },
  },
  required: [
    'contractVersion',
    'jobId',
    'jobType',
    'requestId',
    'revision',
    'logicModelHash',
    'snapshotUri',
    'checkReportHash',
    'clinicalApprovalId',
    'createdBy',
    'createdAt',
  ],
  // mode = 'approved' requires a non-null clinicalApprovalId; every other mode
  // (or no mode) still requires the field to be present, but it may be null.
  if: {
    properties: { mode: { const: 'approved' } },
    required: ['mode'],
  },
  then: {
    properties: { clinicalApprovalId: { type: 'string', minLength: 1 } },
  },
} as unknown as JSONSchemaType<JobPayload>;

export const verifyBuildPayloadSchema: JSONSchemaType<VerifyBuildPayload> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...(jobPayloadSchema.properties as Record<string, unknown>),
    jobType: { const: 'VERIFY_BUILD' },
    compileJobId: { type: 'string', minLength: 1 },
    packageUri: { type: 'string', minLength: 1 },
    packageHash: { type: 'string', minLength: 1 },
    compileArtifactHash: { type: 'string', minLength: 1 },
    manifestHash: { type: 'string', minLength: 1 },
  },
  required: [
    ...(jobPayloadSchema.required as string[]),
    'compileJobId',
    'packageUri',
    'packageHash',
    'compileArtifactHash',
    'manifestHash',
  ],
} as unknown as JSONSchemaType<VerifyBuildPayload>;

export const jobResultSchema: JSONSchemaType<JobResult> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contractVersion: { const: CONTRACT_VERSION },
    jobId: { type: 'string', minLength: 1 },
    jobType: { type: 'string', enum: ['DRAFT_LOGIC', 'COMPILE_LOGIC', 'VERIFY_BUILD'] },
    mode: { type: 'string', enum: ['preview', 'approved'], nullable: true },
    attempt: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['SUCCEEDED', 'FAILED'] },
    logicModelHash: { type: 'string', pattern: LOGIC_MODEL_HASH_PATTERN },
    snapshotHash: { type: 'string', nullable: true },
    inputHash: { type: 'string', nullable: true },
    compileArtifactHash: { type: 'string', nullable: true },
    templateHash: { type: 'string', nullable: true },
    compileErrors: {
      type: 'array',
      nullable: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string' },
          path: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['code', 'path', 'message'],
      },
    },
    retryable: { type: 'boolean', nullable: true },
    manifestHash: { type: 'string', nullable: true },
    manifestUri: { type: 'string', nullable: true },
    packageHash: { type: 'string', nullable: true },
    packageUri: { type: 'string', nullable: true },
    toolVersions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        compileImageDigest: { type: 'string', nullable: true },
        buildImageDigest: { type: 'string', nullable: true },
        compilerCommit: { type: 'string', nullable: true },
        verifierCommit: { type: 'string', nullable: true },
        chtConf: { type: 'string', nullable: true },
        modelId: { type: 'string', nullable: true },
      },
      required: [],
    },
    startedAt: { type: 'string', minLength: 1 },
    finishedAt: { type: 'string', minLength: 1 },
    errorCode: { type: 'string', enum: jobErrorCodeEnum, nullable: true },
    errorMessage: { type: 'string', nullable: true },
    logUri: { type: 'string', nullable: true },
    reportUri: { type: 'string', nullable: true },
    reportHash: { type: 'string', nullable: true },
    verificationPassed: { type: 'boolean', nullable: true },
    coverageComplete: { type: 'boolean', nullable: true },
    testedDirHash: { type: 'string', nullable: true },
    reportVersion: { type: 'string', nullable: true },
  },
  required: [
    'contractVersion',
    'jobId',
    'jobType',
    'attempt',
    'status',
    'logicModelHash',
    'toolVersions',
    'startedAt',
    'finishedAt',
    'errorCode',
    'errorMessage',
  ],
} as unknown as JSONSchemaType<JobResult>;

export const jobEventSchema: JSONSchemaType<JobEvent> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contractVersion: { const: CONTRACT_VERSION },
    jobId: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'] },
    attempt: { type: 'integer', minimum: 1 },
  },
  required: ['contractVersion', 'jobId', 'status', 'attempt'],
} as unknown as JSONSchemaType<JobEvent>;

// --- Ajv validators. Fail closed: treat "not valid" the same as "rejected". ---

const ajv = new Ajv({ allErrors: true, strict: false });

export const validateJobPayload: ValidateFunction<JobPayload> = ajv.compile(jobPayloadSchema);
export const validateVerifyBuildPayload: ValidateFunction<VerifyBuildPayload> = ajv.compile(verifyBuildPayloadSchema);
export const validateJobResult: ValidateFunction<JobResult> = ajv.compile(jobResultSchema);
export const validateJobEvent: ValidateFunction<JobEvent> = ajv.compile(jobEventSchema);
