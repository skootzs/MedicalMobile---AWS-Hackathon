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
  UncoveredBranch,
  VerificationCase,
  VerificationReport,
} from './report.js';
export { VERIFICATION_REPORT_SCHEMA_VERSION } from './report.js';

export type { ExpectedOutcomeSource } from './expected-outcome-source.js';
export {
  EVALUATOR_NOT_WIRED_MESSAGE,
  EvaluatorNotWiredSource,
} from './expected-outcome-source.js';

export type {
  CompileArtifactVerification,
  FileVerifyResult,
  ManifestForVerify,
} from './hashing.js';
export {
  sha256,
  hashFileSet,
  hashDirectory,
  listFilesRelative,
  generatedTranslations,
  verifyCompileArtifact,
  TRANSLATIONS_FILE,
} from './hashing.js';

export type { ChtConfVersion, ChtConfVersionSource, CollectedToolVersions } from './versions.js';
export {
  chtConfVersion,
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
  HarnessTask,
  PatientExecutorOptions,
} from './case-executor.js';
export type { CompileManifest, CoverageCase, ResolvedBranchIds } from './case-executor.js';
export {
  PatientExecutor,
  computeObservedCoverage,
  derivePages,
  outputFieldsFromManifest,
  readManifest,
  resolveBranchIds,
} from './case-executor.js';

export type { MappablePatient, PageSpecLike } from './patient-mapper.js';
export { mapPatientToPages } from './patient-mapper.js';

export type { BuildReportArgs, ExecutedCase, SourceExpectation } from './report-builder.js';
export { buildReport, buildDisagreements, declaredFields, deriveCase, evaluateSource } from './report-builder.js';

export type { PatientCase, RunDeps } from './run.js';
export { runVerification, sanitizeCommand, resolveHarnessModulePath } from './run.js';

export type { LogicModelLike, OutputFieldNames, EvaluatorResult } from './evaluator-normalizer.js';
export {
  ageContextId,
  monthsBetween,
  toEvaluatorAnswers,
  toExpectedFields,
} from './evaluator-normalizer.js';

export type { BridgeCase, BridgeResult, BridgeOutcome } from './evaluator-bridge.js';
export { runEvaluatorBridge } from './evaluator-bridge.js';

export { allToolVersionsKnown } from './versions.js';
