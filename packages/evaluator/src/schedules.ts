import type { LogicModel } from './evaluate.ts';

/** Follow-up days for an outcome id, or null when that outcome has no follow-up. */
export function followUpSchedule(model: LogicModel, outcomeId: string): number | null {
  const outcome = model.outcomes.find((item) => item.id === outcomeId);
  return outcome?.followUp?.afterDays ?? null;
}
