export type {
  CaseKind,
  CaseStatus,
  Coverage,
  Disagreement,
  DisagreementKind,
  ExpectedResult,
  IntegrityCheck,
  JsonValue,
  References,
  ResultStatus,
  RunInfo,
  ToolVersions,
  VerificationCase,
  VerificationReport,
} from './report.js';
export { VERIFICATION_REPORT_SCHEMA_VERSION } from './report.js';

export type { ExpectedOutcomeSource } from './expected-outcome-source.js';
export {
  EVALUATOR_NOT_WIRED_MESSAGE,
  EvaluatorNotWiredSource,
} from './expected-outcome-source.js';

export { sha256, hashFileSet, hashDirectory, compileArtifactHash, listFilesRelative } from './hashing.js';

export {
  collectToolVersions,
  isPythonSupported,
  parsePythonMajorMinor,
  PythonTooOldError,
} from './versions.js';

export type {
  CaseExecutor,
  CaseInput,
  ExecutionResult,
  FillResult,
  HarnessLike,
  PatientExecutorOptions,
} from './case-executor.js';
export {
  PatientExecutor,
  derivePages,
  outputFieldsFromManifest,
  readManifest,
} from './case-executor.js';

export type { BuildReportArgs, ExecutedCase } from './report-builder.js';
export { buildReport, buildDisagreements, deriveStatus } from './report-builder.js';

export type { PatientCase, RunDeps } from './run.js';
export { runVerification } from './run.js';
