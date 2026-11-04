export type {
  CaseKind,
  CaseStatus,
  Coverage,
  Disagreement,
  DisagreementKind,
  ExpectedResult,
  JsonValue,
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
