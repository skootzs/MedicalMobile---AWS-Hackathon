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
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadBranches, loadThresholds } from './data.js';
import { generatePatients, serializePatients } from './patients.js';

export function writePatientsFile(thresholdsPath: string, branchesPath: string, outPath: string): number {
  const thresholds = loadThresholds(thresholdsPath);
  const branches = loadBranches(branchesPath);
  const patients = generatePatients(thresholds, branches, { warn: (m) => process.stderr.write(`${m}\n`) });
  writeFileSync(outPath, serializePatients(patients));
  return patients.length;
}

function main(argv: string[]): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(here, '..', 'data');
  const [thresholds, branches, out] = argv;
  const thresholdsPath = thresholds ?? join(dataDir, 'thresholds.json');
  const branchesPath = branches ?? join(dataDir, 'branches.json');
  const outPath = out ?? join(dataDir, 'patients.json');
  const count = writePatientsFile(thresholdsPath, branchesPath, outPath);
  process.stderr.write(`wrote ${count} patients to ${outPath}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) main(process.argv.slice(2));
