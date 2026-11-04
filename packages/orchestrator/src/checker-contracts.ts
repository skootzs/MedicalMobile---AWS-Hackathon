import { createHash } from 'node:crypto';
import { canonicalizeJson } from './snapshots.ts';
import type { LogicModelSnapshot } from './snapshots.ts';
import type { RevisionIdentity } from './routing.ts';
import type { LogicIdentity } from './workflow.ts';

/** Provisional R2 transport/provenance contracts, not R4's checker algorithms/schema. */
export interface CheckerTarget { checkerActorId: string; checkerId: string; checkerVersion: string }
export interface CheckerInvocation extends CheckerTarget {
  invocationId: string;
  requestId: string;
  requestPreview: RevisionIdentity;
  logic: LogicIdentity;
  workflowVersion: number;
  eventId: string;
}
export interface CheckerFinding {
  id: string;
  code: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  blocking: boolean;
  message: string;
  references: readonly string[];
}
export interface CheckerReport {
  reportId: string;
  resultId: string;
  requestId: string;
  requestPreview: RevisionIdentity;
  logic: LogicIdentity;
  invocationId: string;
  checkerId: string;
  checkerVersion: string;
  outcome: 'PASS' | 'FAIL' | 'ERROR' | 'UNAVAILABLE' | 'INCOMPLETE';
  findings: readonly CheckerFinding[];
  references: readonly string[];
}
export const CHECKER_GATE_POLICY = 'r2-conservative-check-v1' as const;
export interface AcceptedCheckerResult {
  invocation: CheckerInvocation;
  report: CheckerReport;
  eventId: string;
  workflowVersion: number;
  passed: boolean;
  gatePolicyVersion: typeof CHECKER_GATE_POLICY;
}
/** R4 may implement this adapter; R2 ingestion never invokes an actual checker. */
export interface CheckerAdapter { check(invocation: CheckerInvocation, model: LogicModelSnapshot): Promise<CheckerReport> }
export const checkerId = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.trim() === v && v.length <= 100;
export const checkerVersionNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < Number.MAX_SAFE_INTEGER;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const request = (v: unknown) => object(v) && keys(v, ['requestId', 'revision', 'snapshotHash']) && checkerId(v.requestId) && checkerVersionNumber(v.revision) && hash(v.snapshotHash);
const logic = (v: unknown) => object(v) && keys(v, ['logicRevision', 'logicHash']) && checkerVersionNumber(v.logicRevision) && hash(v.logicHash);
const references = (v: unknown) => Array.isArray(v) && v.every(ref => typeof ref === 'string' && !!ref.trim());
export const checkerSame = (a: unknown, b: unknown) => canonicalizeJson(a) === canonicalizeJson(b);
/** Raw sha256 of the canonical checker report. This is the value R7 records as checkReportHash. */
export function checkerReportDigest(report: unknown): string {
  return createHash('sha256').update(canonicalizeJson(report)).digest('hex');
}
export function makeCheckerInvocation(draft: Omit<CheckerInvocation, 'invocationId'>): CheckerInvocation {
  const digest = createHash('sha256').update(canonicalizeJson({ namespace: 'logic-check-invocation-v1', request: draft.requestPreview,
    logic: draft.logic, workflowVersion: draft.workflowVersion, checkerActorId: draft.checkerActorId, checkerId: draft.checkerId, checkerVersion: draft.checkerVersion })).digest('hex');
  return { ...draft, invocationId: `check-${digest}` };
}
export function validInvocation(value: unknown): value is CheckerInvocation {
  try {
    const v = JSON.parse(canonicalizeJson(value));
    if (!object(v) || !keys(v, ['invocationId', 'requestId', 'requestPreview', 'logic', 'workflowVersion', 'eventId', 'checkerActorId', 'checkerId', 'checkerVersion']) ||
        !checkerId(v.invocationId) || !checkerId(v.requestId) || !request(v.requestPreview) || !logic(v.logic) || !checkerVersionNumber(v.workflowVersion) ||
        ![v.eventId, v.checkerActorId, v.checkerId, v.checkerVersion].every(checkerId) || (v.requestPreview as RevisionIdentity).requestId !== v.requestId) return false;
    const { invocationId, ...draft } = v; return invocationId === makeCheckerInvocation(draft as unknown as Omit<CheckerInvocation, 'invocationId'>).invocationId;
  } catch { return false; }
}
/** Shape/provenance transport validation only, without interpreting clinical content. */
export function parseCheckerReport(value: unknown): CheckerReport | null {
  try {
    const r = JSON.parse(canonicalizeJson(value));
    if (!object(r) || !keys(r, ['reportId', 'resultId', 'requestId', 'requestPreview', 'logic', 'invocationId', 'checkerId', 'checkerVersion', 'outcome', 'findings', 'references']) ||
        ![r.reportId, r.resultId, r.requestId, r.invocationId, r.checkerId, r.checkerVersion].every(checkerId) || !request(r.requestPreview) || !logic(r.logic) ||
        (r.requestPreview as RevisionIdentity).requestId !== r.requestId || !['PASS', 'FAIL', 'ERROR', 'UNAVAILABLE', 'INCOMPLETE'].includes(r.outcome as string) || !references(r.references) || !Array.isArray(r.findings) ||
        r.findings.some(f => !object(f) || !keys(f, ['id', 'code', 'severity', 'blocking', 'message', 'references']) || !checkerId(f.id) || !checkerId(f.code) ||
          !['INFO', 'WARNING', 'ERROR'].includes(f.severity as string) || typeof f.blocking !== 'boolean' || typeof f.message !== 'string' || !f.message.trim() || !references(f.references))) return null;
    if (new Set(r.findings.map(f => (f as CheckerFinding).id)).size !== r.findings.length) return null;
    return r as unknown as CheckerReport;
  } catch { return null; }
}
export function reportMatchesInvocation(report: CheckerReport, invocation: CheckerInvocation): boolean {
  return report.requestId === invocation.requestId && report.invocationId === invocation.invocationId && report.checkerId === invocation.checkerId &&
    report.checkerVersion === invocation.checkerVersion && checkerSame(report.requestPreview, invocation.requestPreview) && checkerSame(report.logic, invocation.logic);
}
/** Explicit conservative gate mapping, not a checker: unresolved warnings never imply safety. */
export function checkerCompleted(report: CheckerReport): boolean { return !['UNAVAILABLE', 'INCOMPLETE'].includes(report.outcome); }
export function checkerPassed(report: CheckerReport): boolean { return report.outcome === 'PASS' && report.findings.every(f => !f.blocking && f.severity === 'INFO'); }
export function validCheckerResult(value: unknown): value is AcceptedCheckerResult {
  try {
    const r = JSON.parse(canonicalizeJson(value));
    if (!object(r) || !keys(r, ['invocation', 'report', 'eventId', 'workflowVersion', 'passed', 'gatePolicyVersion']) || !validInvocation(r.invocation) ||
        !checkerId(r.eventId) || !checkerVersionNumber(r.workflowVersion) || typeof r.passed !== 'boolean' || r.gatePolicyVersion !== CHECKER_GATE_POLICY) return false;
    const report = parseCheckerReport(r.report);
    return !!report && checkerCompleted(report) && reportMatchesInvocation(report, r.invocation) && r.workflowVersion === r.invocation.workflowVersion + 1 && r.passed === checkerPassed(report);
  } catch { return false; }
}

/** One shared formal-evidence binding check for review reads and approval writes. */
export function checkerEvidenceMatches(result: unknown, binding: { request: RevisionIdentity; logic: LogicIdentity; reportId: string; eventId: string; invocationId: string | undefined; passed: boolean; actorId: string }): result is AcceptedCheckerResult {
  return validCheckerResult(result) && result.eventId === binding.eventId && result.invocation.checkerActorId === binding.actorId && result.invocation.invocationId === binding.invocationId &&
    result.report.reportId === binding.reportId && result.passed === binding.passed && checkerSame(result.report.requestPreview, binding.request) && checkerSame(result.report.logic, binding.logic);
}
