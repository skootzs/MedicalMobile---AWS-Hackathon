import { boundaryNumbers, referencedIds, type ConditionNode, type InputValue } from './conditions.ts';

export interface DomainModel {
  applicability?: { when: ConditionNode };
  context?: { id: string }[];
  questions: { id: string; type: string; options?: { id: string }[] }[];
  derived: { id: string; when: ConditionNode }[];
  decisionTables: { rows: { when: ConditionNode }[] }[];
}

function conditions(model: DomainModel): ConditionNode[] {
  const nodes: ConditionNode[] = [];
  if (model.applicability) nodes.push(model.applicability.when);
  for (const item of model.derived) nodes.push(item.when);
  for (const row of model.decisionTables[0]?.rows ?? []) nodes.push(row.when);
  return nodes;
}

/**
 * Finite values used to look for overlapping rows.
 * Booleans are true and false. Numbers are each compared threshold, one step
 * either side, and unanswered. This is not every integer.
 */
export function boundaryDomains(model: DomainModel): { id: string; values: InputValue[] }[] {
  const nodes = conditions(model);
  const domains: { id: string; values: InputValue[] }[] = [];
  for (const item of model.context ?? []) {
    const numbers = new Set<number>();
    for (const node of nodes) boundaryNumbers(node, item.id, numbers);
    domains.push({ id: item.id, values: [null, ...[...numbers].sort((a, b) => a - b)] });
  }
  for (const question of model.questions) {
    if (question.type === 'boolean') domains.push({ id: question.id, values: [true, false] });
    else if (question.type === 'select_one') domains.push({ id: question.id, values: (question.options ?? []).map((option) => option.id) });
    else if (question.type === 'integer' || question.type === 'decimal') {
      const numbers = new Set<number>();
      for (const node of nodes) boundaryNumbers(node, question.id, numbers);
      domains.push({ id: question.id, values: [null, ...[...numbers].sort((a, b) => a - b)] });
    }
  }
  return domains;
}

export function domainSize(domains: { values: unknown[] }[]): number {
  return domains.reduce((product, domain) => product * domain.values.length, 1);
}

export function idsRead(model: DomainModel): Set<string> {
  const ids = new Set<string>();
  for (const node of conditions(model)) referencedIds(node, ids);
  return ids;
}
