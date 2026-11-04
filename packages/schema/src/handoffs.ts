// R2/R7 job delivery contract: payload and result types that cross the
// jobs queue, plus JSON Schema + Ajv validators for each. Every service
// validates what it receives against these schemas and fails closed.
//
// Full narrative contract (hash identities, key layout, lease/retry
// behavior): docs/job-delivery.md in the r7-infra branch.
//
// Confirmed with R4 (skootzs): this is the agreed home for these types.
import { Ajv, type JSONSchemaType, type ValidateFunction } from 'ajv';

export const CONTRACT_VERSION = '1.1.0';
// 1.1.0 only adds optional fields, so payloads still on 1.0.0 stay valid.
const ACCEPTED_PAYLOAD_VERSIONS = ['1.0.0', CONTRACT_VERSION];

export type JobType = 'DRAFT_LOGIC' | 'COMPILE_LOGIC' | 'VERIFY_BUILD';
export type CompileMode = 'preview' | 'approved';
export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
// R2's execution vocabulary for COMPILE_LOGIC results.
export type ChtConfStatus = 'NOT_RUN' | 'PASSED' | 'FAILED';
export type CompileFailureKind =
  | 'COMPILER_REJECTED'
  | 'COMPILER_USAGE_OR_FILE_ERROR'
  | 'CHT_CONVERSION_FAILED'
  | 'CHT_VALIDATION_FAILED'
  | 'RUNNER_FAILED'
  | 'TIMED_OUT'
  | 'RETRIES_EXHAUSTED';

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
  contractVersion: string; // CONTRACT_VERSION, or 1.0.0 from a sender not yet updated
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
  // Baseline diff support (compiler@7f488e6): R2 decides which build is "last
  // deployed"; the runner just uses the URI it's given. If set, the runner
  // downloads it, verifies the stored hashes, mounts it read-only at
  // /baseline, and passes --baseline /baseline to the compiler.
  baselineUri?: string | null; // S3 prefix of the last deployed build's /out (compile-manifest.json + compile-rows.json)
  taskWindow?: string | null; // "<start>,<end>" days before/after the follow-up date; passed as --task-window verbatim
  // Golden cases from the same approved snapshot. Set both or neither. Absent means the
  // verifier runs evaluator-only and says so in its report.
  goldenCasesUri?: string;
  goldenCasesHash?: string;
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
  compileArtifactHash?: string; // compile-manifest.json artifactHash (compiler@7f488e6: also covers tasks.js when the pathway has a follow-up; no runner change needed)
  templateHash?: string; // compile-manifest.json template.hash
  compileErrors?: { code: string; path: string; message: string }[]; // compiler exit 1 (stderr JSON)
  retryable?: boolean; // false for MODEL_REJECTED, true for infra errors
  compilerExitCode?: 0 | 1 | 2 | null; // COMPILE_LOGIC only; null when the compiler gave no contract exit code
  chtConfStatus?: ChtConfStatus; // COMPILE_LOGIC only
  failureKind?: CompileFailureKind | null; // COMPILE_LOGIC only
  manifestHash?: string;
  manifestUri?: string;
  manifestVersionId?: string; // S3 version of manifest.json
  compileDiffUri?: string; // s3://... location of compile-diff.json; only present when the job had a baselineUri
  packageHash?: string;
  packageUri?: string; // s3://.../builds/<logicModelHash>/<jobId>/attempt-<n>/project.tgz
  packageVersionId?: string; // S3 version of project.tgz
  // The compile report is compile-manifest.json.
  compileReportUri?: string;
  compileReportHash?: string;
  compileReportVersionId?: string;
  toolVersions: {
    compileImageDigest?: string;
    buildImageDigest?: string;
    compiler?: string; // what R2 compares; the same value as compilerCommit
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
  reportVersionId?: string; // S3 version of report.json
  reportHash?: string;
  verificationPassed?: boolean; // copied from report.passed
  coverageComplete?: boolean; // copied from report.coverageComplete
  testedDirHash?: string; // copied from report (VerificationReport v2.0.0)
  reportVersion?: string; // e.g. "2.0.0"
}

// Thin; R2 reads the job item for details. The events Pipe sends only jobId, status and attempt.
export interface JobEvent {
  contractVersion?: typeof CONTRACT_VERSION;
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

const goldenCasesTogether = {
  goldenCasesUri: ['goldenCasesHash'],
  goldenCasesHash: ['goldenCasesUri'],
};

export const jobPayloadSchema: JSONSchemaType<JobPayload> = {
  type: 'object',
  additionalProperties: false,
  dependencies: goldenCasesTogether,
  properties: {
    contractVersion: { enum: ACCEPTED_PAYLOAD_VERSIONS },
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
    baselineUri: { type: 'string', nullable: true },
    taskWindow: { type: 'string', pattern: '^\\d+,\\d+$', nullable: true },
    goldenCasesUri: { type: 'string', minLength: 1, nullable: true },
    goldenCasesHash: { type: 'string', minLength: 1, nullable: true },
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
  dependencies: goldenCasesTogether,
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
    compilerExitCode: { type: 'integer', enum: [0, 1, 2, null], nullable: true },
    chtConfStatus: { type: 'string', enum: ['NOT_RUN', 'PASSED', 'FAILED'], nullable: true },
    failureKind: {
      type: 'string',
      enum: ['COMPILER_REJECTED', 'COMPILER_USAGE_OR_FILE_ERROR', 'CHT_CONVERSION_FAILED', 'CHT_VALIDATION_FAILED', 'RUNNER_FAILED', 'TIMED_OUT', 'RETRIES_EXHAUSTED', null],
      nullable: true,
    },
    manifestHash: { type: 'string', nullable: true },
    manifestUri: { type: 'string', nullable: true },
    manifestVersionId: { type: 'string', nullable: true },
    compileDiffUri: { type: 'string', nullable: true },
    packageHash: { type: 'string', nullable: true },
    packageUri: { type: 'string', nullable: true },
    packageVersionId: { type: 'string', nullable: true },
    compileReportUri: { type: 'string', nullable: true },
    compileReportHash: { type: 'string', nullable: true },
    compileReportVersionId: { type: 'string', nullable: true },
    toolVersions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        compileImageDigest: { type: 'string', nullable: true },
        buildImageDigest: { type: 'string', nullable: true },
        compiler: { type: 'string', nullable: true },
        compilerCommit: { type: 'string', nullable: true },
        verifierCommit: { type: 'string', nullable: true },
        chtConf: { type: 'string', nullable: true },
        modelId: { type: 'string', nullable: true },
      },
      required: [],
    },
    startedAt: { type: 'string', minLength: 1 },
    finishedAt: { type: 'string', minLength: 1 },
    // `nullable: true` only patches the implicit `type`; `enum` needs `null` listed explicitly too.
    errorCode: { type: 'string', enum: [...jobErrorCodeEnum, null], nullable: true },
    errorMessage: { type: 'string', nullable: true },
    logUri: { type: 'string', nullable: true },
    reportUri: { type: 'string', nullable: true },
    reportVersionId: { type: 'string', nullable: true },
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
    contractVersion: { type: 'string', const: CONTRACT_VERSION, nullable: true },
    jobId: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'] },
    attempt: { type: 'integer', minimum: 1 },
  },
  required: ['jobId', 'status', 'attempt'],
} as unknown as JSONSchemaType<JobEvent>;

// --- Ajv validators. Fail closed: treat "not valid" the same as "rejected". ---

const ajv = new Ajv({ allErrors: true, strict: false });

export const validateJobPayload: ValidateFunction<JobPayload> = ajv.compile(jobPayloadSchema);
export const validateVerifyBuildPayload: ValidateFunction<VerifyBuildPayload> = ajv.compile(verifyBuildPayloadSchema);
export const validateJobResult: ValidateFunction<JobResult> = ajv.compile(jobResultSchema);
export const validateJobEvent: ValidateFunction<JobEvent> = ajv.compile(jobEventSchema);
