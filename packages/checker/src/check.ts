// Structural checks, golden-case comparison, and a boundary search for overlapping rows.
// A passing report is not clinical approval. Findings that limit the proof are INFO,
// because the orchestrator treats any warning as a failed gate.

import { validateGoldenCases, validateLogicModel } from '../../schema/src/validate.ts';
import { boundaryDomains, domainSize } from '../../evaluator/src/domain.ts';
import { referencedIds, type Answers, type ConditionNode, type InputValue } from '../../evaluator/src/conditions.ts';
import { evaluateLogicModel, reportFields, type LogicModel } from '../../evaluator/src/evaluate.ts';

export interface Finding {
  id: string;
  code: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  blocking: boolean;
  message: string;
  references: string[];
}

export interface CheckResult {
  outcome: 'PASS' | 'FAIL';
  findings: Finding[];
}

export interface GoldenCase {
  id: string;
  approval?: string;
  input: Answers;
  expected: Record<string, string>;
}

interface CheckModel extends LogicModel {
  pathwayId?: string;
  questions: { id: string; type: string; options?: { id: string }[]; relevantWhen?: ConditionNode }[];
  ambiguities?: { id: string; status: string; blocking: boolean; text?: string }[];
  decisionTables: { hitPolicy?: string; rows: { when: ConditionNode; outcome: string }[]; otherwise: string }[];
}

const ANALYSIS_CAP = 50_000;

function finding(id: string, code: string, severity: Finding['severity'], blocking: boolean, message: string, references: string[] = []): Finding {
  return { id, code, severity, blocking, message, references };
}

function conditionsOf(model: CheckModel): { path: string; node: ConditionNode; visible: Set<string> }[] {
  const visible = new Set<string>();
  for (const item of model.context ?? []) visible.add(item.id);
  const out: { path: string; node: ConditionNode; visible: Set<string> }[] = [];
  if (model.applicability) out.push({ path: '$.applicability.when', node: model.applicability.when, visible: new Set(visible) });
  model.questions.forEach((question, index) => {
    if (question.relevantWhen) out.push({ path: `$.questions[${index}].relevantWhen`, node: question.relevantWhen, visible: new Set(visible) });
    visible.add(question.id);
  });
  for (const item of model.derived) {
    out.push({ path: `$.derived.${item.id}`, node: item.when, visible: new Set(visible) });
    visible.add(item.id);
  }
  model.decisionTables[0]?.rows.forEach((row, index) => {
    out.push({ path: `$.decisionTables[0].rows[${index}].when`, node: row.when, visible: new Set(visible) });
  });
  return out;
}

export function checkLogicModel(model: unknown, goldenCases: unknown = []): CheckResult {
  const findings: Finding[] = [];
  const schema = validateLogicModel(model);
  if (!schema.ok) {
    schema.errors.forEach((error, index) => {
      findings.push(finding(`schema-${index + 1}`, 'SCHEMA', 'ERROR', true, `${error.path}: ${error.message}`, [error.path]));
    });
    return { outcome: 'FAIL', findings };
  }

  const casesResult = validateGoldenCases(goldenCases);
  if (!casesResult.ok) {
    casesResult.errors.forEach((error, index) => {
      findings.push(finding(`golden-schema-${index + 1}`, 'GOLDEN_SCHEMA', 'ERROR', true, `${error.path}: ${error.message}`));
    });
    return { outcome: 'FAIL', findings };
  }

  const logic = model as CheckModel;
  const cases = goldenCases as GoldenCase[];
  const ids = new Map<string, string>();
  const claim = (id: string, path: string) => {
    const previous = ids.get(id);
    if (previous) findings.push(finding(`dup-${id}`, 'DUPLICATE_ID', 'ERROR', true, `${id} is used at ${previous} and ${path}`, [path]));
    else ids.set(id, path);
  };
  for (const item of logic.context ?? []) claim(item.id, 'context');
  logic.questions.forEach((question, index) => claim(question.id, `$.questions[${index}]`));
  logic.derived.forEach((item) => claim(item.id, `$.derived.${item.id}`));
  logic.outcomes.forEach((item) => claim(item.id, `$.outcomes.${item.id}`));

  for (const site of conditionsOf(logic)) {
    for (const id of referencedIds(site.node)) {
      if (!site.visible.has(id)) {
        findings.push(finding(`ref-${site.path}-${id}`, 'UNKNOWN_REFERENCE', 'ERROR', true, `${site.path} reads ${id}, which is not visible there`, [site.path]));
      }
    }
  }

  const produced = new Set<string>();
  for (const row of logic.decisionTables[0]?.rows ?? []) produced.add(row.outcome);
  if (logic.decisionTables[0]) produced.add(logic.decisionTables[0].otherwise);
  if (logic.applicability) {
    produced.add(logic.applicability.notApplicableOutcome);
    produced.add(logic.applicability.unknownOutcome);
  }
  for (const outcome of logic.outcomes) {
    if (!produced.has(outcome.id)) {
      findings.push(finding(`unreferenced-${outcome.id}`, 'UNREFERENCED_OUTCOME', 'ERROR', true, `Outcome ${outcome.id} is not produced by a row, the catch-all, or applicability`));
    }
  }

  for (const ambiguity of logic.ambiguities ?? []) {
    if (ambiguity.status === 'open' && ambiguity.blocking) {
      findings.push(finding(`ambiguity-${ambiguity.id}`, 'BLOCKING_AMBIGUITY', 'ERROR', true, ambiguity.text ?? ambiguity.id, [ambiguity.id]));
    }
  }

  for (const item of cases) {
    let actual: Record<string, string>;
    try {
      actual = reportFields(evaluateLogicModel(logic, item.input));
    } catch (error) {
      findings.push(finding(`golden-${item.id}`, 'GOLDEN_MISMATCH', 'ERROR', true, `${item.id} could not be evaluated: ${error instanceof Error ? error.message : String(error)}`));
      continue;
    }
    const mismatches = Object.keys(item.expected).filter((key) => actual[key] !== item.expected[key]);
    if (mismatches.length > 0) {
      const detail = mismatches.map((key) => `${key}: expected ${JSON.stringify(item.expected[key])} got ${JSON.stringify(actual[key] ?? null)}`).join('; ');
      findings.push(finding(`golden-${item.id}`, 'GOLDEN_MISMATCH', 'ERROR', true, `${item.id} does not match the evaluator. ${detail}`));
    }
  }

  const domains = boundaryDomains(logic);
  const size = domainSize(domains);
  if (size === 0 || size > ANALYSIS_CAP) {
    findings.push(finding('analysis-limit', 'ANALYSIS_LIMIT', 'INFO', false, `Overlap was not searched across ${size} boundary combinations (limit ${ANALYSIS_CAP}).`));
  } else {
    const overlaps = searchOverlaps(logic, domains);
    const policy = logic.decisionTables[0]?.hitPolicy ?? 'unique';
    if (overlaps.length > 0 && policy === 'unique') {
      const witness = overlaps[0]!;
      findings.push(finding('overlap', 'OVERLAP', 'ERROR', true, `Two decision rows are both true for one input: ${JSON.stringify(witness.input)}. Rows ${witness.rows.join(' and ')}.`, witness.rows.map(String)));
    } else if (overlaps.length > 0) {
      findings.push(finding('overlap-first', 'OVERLAP_FIRST_POLICY', 'INFO', false, `hitPolicy is first, so ${overlaps.length} boundary inputs match more than one row. The first matching row is used.`));
    } else {
      findings.push(finding('no-overlap', 'NO_OVERLAP_ON_BOUNDARY', 'INFO', false, `No two rows were both true on ${size} boundary inputs (each compared number, one step either side, and unanswered). Integers between those points were not all enumerated.`));
    }
  }

  const approved = cases.length > 0 && cases.every((item) => item.approval && item.approval !== 'not-clinician-approved');
  findings.push(finding(
    'not-clinical-approval',
    'NOT_CLINICAL_APPROVAL',
    'INFO',
    false,
    approved
      ? 'Every supplied golden case is marked approved. This checker still does not decide clinical correctness by itself.'
      : 'Golden cases are technical expectations until a clinician approves them. This checker does not make that approval.',
  ));

  const blocking = findings.some((item) => item.blocking);
  return { outcome: blocking ? 'FAIL' : 'PASS', findings };
}

function searchOverlaps(model: CheckModel, domains: { id: string; values: InputValue[] }[]): { input: Answers; rows: number[] }[] {
  const found: { input: Answers; rows: number[] }[] = [];
  const input: Answers = {};
  const walk = (index: number) => {
    if (found.length >= 1) return;
    if (index === domains.length) {
      try {
        const evaluation = evaluateLogicModel(model, input);
        if (evaluation.matchedRows.length > 1) found.push({ input: { ...input }, rows: [...evaluation.matchedRows] });
      } catch {
        // A boundary point the model rejects is not an overlap witness.
      }
      return;
    }
    const domain = domains[index]!;
    for (const value of domain.values) {
      input[domain.id] = value;
      walk(index + 1);
      if (found.length >= 1) return;
    }
  };
  walk(0);
  return found;
}
