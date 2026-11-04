export type CompileErrorCode =
  | 'INVALID_INPUT'
  | 'UNKNOWN_FIELD'
  | 'MISSING_FIELD'
  | 'INVALID_VALUE'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'UNSUPPORTED_LANGUAGE'
  | 'UNSUPPORTED_CONTEXT'
  | 'UNSUPPORTED_QUESTION_TYPE'
  | 'UNSUPPORTED_NODE'
  | 'UNSUPPORTED_TEXT'
  | 'UNSUPPORTED_DECISION_TABLE_COUNT'
  | 'INVALID_ID'
  | 'RESERVED_ID'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_REFERENCE'
  | 'FORWARD_REFERENCE'
  | 'TYPE_MISMATCH'
  | 'UNKNOWN_OPTION'
  | 'UNKNOWN_SOURCE'
  | 'UNKNOWN_PAGE'
  | 'EMPTY_PAGE'
  | 'UNKNOWN_OUTCOME'
  | 'UNREACHABLE_OUTCOME'
  | 'OPEN_BLOCKING_AMBIGUITY';

export interface CompileError {
  code: CompileErrorCode;
  path: string;
  message: string;
}

export class ErrorList {
  readonly items: CompileError[] = [];

  add(code: CompileErrorCode, path: string, message: string): void {
    this.items.push({ code, path, message });
  }

  get empty(): boolean {
    return this.items.length === 0;
  }
}
