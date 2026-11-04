export type {
  Baseline,
  BranchesData,
  BranchSpec,
  RateRelation,
  RespiratoryRateThreshold,
  SignField,
  StepValue,
  ThresholdOperator,
  ThresholdsData,
} from './data.js';
export {
  CONFIRMED_DATA_STATUS,
  SIGN_FIELDS,
  dataStatusWarnings,
  loadBranches,
  loadThresholds,
  parseBranches,
  parseThresholds,
} from './data.js';

export type { GenerateOptions, PatientInput, PatientKind } from './patients.js';
export { generatePatients } from './patients.js';

export type { CoverageResult } from './coverage.js';
export { computeCoverage } from './coverage.js';

export type { GoldenCase, GoldenCaseSet, JsonValue } from './expected.js';
export { loadGoldenCases, parseGoldenCases } from './expected.js';
