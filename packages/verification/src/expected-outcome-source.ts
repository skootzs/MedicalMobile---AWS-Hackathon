/**
 * A source of expected outcomes for synthetic patients.
 *
 * Expected outcomes come only from golden cases or from the teammate's
 * deterministic evaluator over approved logic. This package never computes
 * them itself, and no model is ever involved.
 *
 * TInput and TOutcome are generic because the evaluator's input and output
 * types are not defined yet. Do not narrow them here; reconcile once the
 * evaluator package publishes its types.
 *
 * The return may be sync or async, so either kind of evaluator fits.
 * Callers must always `await` the result.
 */
export interface ExpectedOutcomeSource<TInput, TOutcome> {
  expectedOutcome(input: TInput): TOutcome | Promise<TOutcome>;
}

export const EVALUATOR_NOT_WIRED_MESSAGE = 'evaluator not wired yet';

/**
 * Placeholder for the evaluator-backed source. Always throws.
 * Replace with a real adapter once packages/evaluator exposes its API.
 */
export class EvaluatorNotWiredSource<TInput, TOutcome>
  implements ExpectedOutcomeSource<TInput, TOutcome>
{
  expectedOutcome(_input: TInput): TOutcome {
    throw new Error(EVALUATOR_NOT_WIRED_MESSAGE);
  }
}
