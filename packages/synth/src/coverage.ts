/**
 * Branch coverage: which branches the harness actually hit.
 *
 * Field names match Coverage in packages/verification/src/report.ts so the
 * result drops straight into a VerificationReport.
 */

export interface CoverageResult {
  totalBranches: number;
  coveredBranches: number;
  /** In the order of the branch list. */
  uncoveredBranchIds: string[];
}

/**
 * @param branchIds    every branch the pathway defines (from branches.json)
 * @param hitBranchIds branch ids the harness run actually reached
 * @throws if branchIds has duplicates, or a hit id is not a known branch
 *         (that means the data and the run disagree, which must not pass silently)
 */
export function computeCoverage(
  branchIds: readonly string[],
  hitBranchIds: Iterable<string>,
): CoverageResult {
  const known = new Set<string>();
  for (const id of branchIds) {
    if (known.has(id)) throw new Error(`duplicate branch id "${id}"`);
    known.add(id);
  }

  const hit = new Set<string>();
  for (const id of hitBranchIds) {
    if (!known.has(id)) throw new Error(`hit branch id "${id}" is not in the branch list`);
    hit.add(id);
  }

  const uncoveredBranchIds = branchIds.filter((id) => !hit.has(id));
  return {
    totalBranches: branchIds.length,
    coveredBranches: branchIds.length - uncoveredBranchIds.length,
    uncoveredBranchIds,
  };
}
