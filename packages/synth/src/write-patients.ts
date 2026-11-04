/**
 * CLI: generate the deterministic patient set and write it to a JSON file.
 *
 * Usage:
 *   node dist/write-patients.js <thresholds.json> <branches.json> <out patients.json>
 *
 * Defaults to the package's own data/ files and data/patients.json when run
 * with no arguments. Prints the unconfirmed-data warnings to stderr. Writes no
 * expected outcomes.
 */
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadBranches, loadThresholds } from './data.js';
import { generatePatients, serializePatients } from './patients.js';
import { generateFromLogicModel, loadLogicModel } from './logic-model.js';

export function writePatientsFile(thresholdsPath: string, branchesPath: string, outPath: string): number {
  const thresholds = loadThresholds(thresholdsPath);
  const branches = loadBranches(branchesPath);
  const patients = generatePatients(thresholds, branches, { warn: (m) => process.stderr.write(`${m}\n`) });
  writeFileSync(outPath, serializePatients(patients));
  return patients.length;
}

/** Generate from a logic model and write deterministically. */
export function writeFromLogicModel(logicModelPath: string, outPath: string): number {
  const { patients, boundaries } = generateFromLogicModel(loadLogicModel(logicModelPath));
  writeFileSync(outPath, serializePatients(patients));
  process.stderr.write(`derived boundaries from ${logicModelPath}: ${JSON.stringify(boundaries)}\n`);
  return patients.length;
}

function main(argv: string[]): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(here, '..', 'data');
  const out = argv[0] ?? join(dataDir, 'patients.json');
  // Prefer a logic model (L2): LOGIC_MODEL_FILE, else /in/logic.json if present,
  // else fall back to the sample data with its "unconfirmed" warning (L3).
  const logicModelPath =
    process.env['LOGIC_MODEL_FILE'] ?? (existsSync('/in/logic.json') ? '/in/logic.json' : null);
  if (logicModelPath && existsSync(logicModelPath)) {
    const count = writeFromLogicModel(logicModelPath, out);
    process.stderr.write(`wrote ${count} patients (from logic model) to ${out}\n`);
    return;
  }
  process.stderr.write('no logic model available; falling back to sample thresholds/branches (unconfirmed)\n');
  const count = writePatientsFile(join(dataDir, 'thresholds.json'), join(dataDir, 'branches.json'), out);
  process.stderr.write(`wrote ${count} patients (from sample data) to ${out}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) main(process.argv.slice(2));
