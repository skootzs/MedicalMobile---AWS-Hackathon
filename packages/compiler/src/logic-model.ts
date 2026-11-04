// PROVISIONAL input contract. Mirrors packages/compiler/docs/logic-model-v1-proposal.md
// until Role 4 publishes the shared LogicModel schema in packages/schema.

export type Id = string;

export interface Source {
  id: Id;
  title: string;
  sha256?: string;
  url?: string;
}

export interface SourceRef {
  sourceId: Id;
  page?: number;
  section?: string;
  quote?: string;
}

export type Literal = boolean | number | string;

export type Condition =
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition }
  | { eq: [Id, Literal] }
  | { neq: [Id, Literal] }
  | { lt: [Id, number] }
  | { lte: [Id, number] }
  | { gt: [Id, number] }
  | { gte: [Id, number] }
  | { answered: Id };

export interface ContextValue {
  id: Id;
  type: 'integer';
  from: 'contact.age_in_months';
}

export interface Page {
  id: Id;
  label: string;
}

export interface Option {
  id: Id;
  label: string;
}

export type QuestionType = 'boolean' | 'integer' | 'decimal' | 'select_one';

export interface Question {
  id: Id;
  type: QuestionType;
  label: string;
  hint?: string;
  page?: Id;
  options?: Option[];
  min?: number;
  max?: number;
  relevantWhen?: Condition;
  source?: SourceRef;
}

export interface Derived {
  id: Id;
  type: 'boolean';
  when: Condition;
  source?: SourceRef;
}

export interface DecisionRow {
  when: Condition;
  outcome: Id;
  source?: SourceRef;
}

export interface DecisionTable {
  id: Id;
  hitPolicy: 'unique' | 'first';
  rows: DecisionRow[];
  otherwise: Id;
}

export interface Outcome {
  id: Id;
  label: string;
  referral: 'urgent' | 'none';
  followUp?: { afterDays: number };
  message?: string;
}

export interface Applicability {
  when: Condition;
  notApplicableOutcome: Id;
  unknownOutcome: Id;
  source?: SourceRef;
}

export interface Ambiguity {
  id: Id;
  text: string;
  status: 'open' | 'resolved';
  blocking: boolean;
  sourceRef?: SourceRef;
  resolution?: string;
}

export interface LogicModel {
  schemaVersion: '1.0';
  pathwayId: Id;
  title: string;
  language: 'en';
  sources: Source[];
  context: ContextValue[];
  applicability?: Applicability;
  pages?: Page[];
  questions: Question[];
  derived: Derived[];
  decisionTables: DecisionTable[];
  outcomes: Outcome[];
  ambiguities: Ambiguity[];
}
