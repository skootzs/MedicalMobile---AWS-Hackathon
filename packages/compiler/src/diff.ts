import type { CompiledArtifact, CompileManifest } from './compile.ts';
import type { XlsForm, XlsFormRow, XlsFormSheet } from './xlsform-adapter.ts';

export const DIFF_FILE = 'compile-diff.json';

export interface CellChange {
  before: string;
  after: string;
}

export interface RowChanges {
  added: string[];
  removed: string[];
  changed: { key: string; columns: Record<string, CellChange> }[];
}

export interface CompileDiff {
  diffVersion: 1;
  baseline: { formId: string; inputHash: string; artifactHash: string; snapshotHash: string | null };
  current: { formId: string; inputHash: string; artifactHash: string; snapshotHash: string | null };
  /** True when the generated files are byte-identical to the baseline. */
  identical: boolean;
  survey: RowChanges;
  choices: RowChanges;
  /** Settings columns that changed, except `version`, which changes with every input. */
  settings: Record<string, CellChange>;
  outcomes: { added: string[]; removed: string[]; changed: { id: string; before: unknown; after: unknown }[] };
  tasks: { before: unknown; after: unknown } | null;
  /** Things a deploy approver must look at, e.g. fields that existing reports use being removed. */
  warnings: string[];
}

// Survey rows keyed by their group path, so `_id` under contact and under parent stay distinct.
function surveyKeys(sheet: XlsFormSheet): Map<string, XlsFormRow> {
  const out = new Map<string, XlsFormRow>();
  const stack: string[] = [];
  for (const row of sheet.rows) {
    const type = (row.type ?? '').trim();
    const name = row.name ?? '';
    if (/^end[ _](group|repeat)$/.test(type)) {
      out.set(`${stack.join('/')}#end`, row);
      stack.pop();
      continue;
    }
    const key = [...stack, name].join('/');
    out.set(key, row);
    if (/^begin[ _](group|repeat)$/.test(type)) stack.push(name);
  }
  return out;
}

function choiceKeys(sheet: XlsFormSheet): Map<string, XlsFormRow> {
  return new Map(sheet.rows.map((r) => [`${r.list_name ?? ''}/${r.name ?? ''}`, r]));
}

function compareRows(before: Map<string, XlsFormRow>, after: Map<string, XlsFormRow>, ignore: string[] = []): RowChanges {
  const added = [...after.keys()].filter((k) => !before.has(k)).sort();
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
  const changed: RowChanges['changed'] = [];
  for (const key of [...after.keys()].filter((k) => before.has(k)).sort()) {
    const a = before.get(key)!;
    const b = after.get(key)!;
    const columns: Record<string, CellChange> = {};
    for (const col of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (ignore.includes(col)) continue;
      const x = a[col] ?? '';
      const y = b[col] ?? '';
      if (x !== y) columns[col] = { before: x, after: y };
    }
    if (Object.keys(columns).length > 0) changed.push({ key, columns });
  }
  return { added, removed, changed };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const ANSWER_TYPES = /^(select_one|select_multiple|integer|decimal|string|text|date|time|datetime)\b/;

export function diffAgainstBaseline(
  artifact: CompiledArtifact,
  baselineManifest: CompileManifest,
  baselineRows: XlsForm,
): CompileDiff {
  const m = artifact.manifest;
  const survey = compareRows(surveyKeys(baselineRows.survey), surveyKeys(artifact.xlsForm.survey));
  const choices = compareRows(choiceKeys(baselineRows.choices), choiceKeys(artifact.xlsForm.choices));
  const settings = compareRows(
    new Map([['settings', baselineRows.settings.rows[0] ?? {}]]),
    new Map([['settings', artifact.xlsForm.settings.rows[0] ?? {}]]),
    ['version'],
  ).changed[0]?.columns ?? {};

  const beforeOutcomes = new Map((baselineManifest.outcomes ?? []).map((o) => [o.id, o]));
  const afterOutcomes = new Map(m.outcomes.map((o) => [o.id, o]));
  const outcomes: CompileDiff['outcomes'] = {
    added: [...afterOutcomes.keys()].filter((k) => !beforeOutcomes.has(k)).sort(),
    removed: [...beforeOutcomes.keys()].filter((k) => !afterOutcomes.has(k)).sort(),
    changed: [...afterOutcomes.keys()]
      .filter((k) => beforeOutcomes.has(k) && !sameJson(beforeOutcomes.get(k), afterOutcomes.get(k)))
      .sort()
      .map((id) => ({ id, before: beforeOutcomes.get(id), after: afterOutcomes.get(id) })),
  };
  const tasks = sameJson(baselineManifest.tasks, m.tasks) ? null : { before: baselineManifest.tasks ?? null, after: m.tasks };

  const warnings: string[] = [];
  if (baselineManifest.formId !== m.formId) {
    warnings.push(`Form id changed from '${baselineManifest.formId}' to '${m.formId}': this deploys a new form, not an update.`);
  }
  const beforeSurvey = surveyKeys(baselineRows.survey);
  const removedFields = survey.removed.filter((k) => !k.endsWith('#end'));
  if (removedFields.length > 0) {
    warnings.push(`Fields removed: ${removedFields.join(', ')}. Existing reports keep these fields; anything that reads them (tasks, targets, analytics) must be checked.`);
  }
  const removedAnswers = removedFields.filter((k) => ANSWER_TYPES.test(beforeSurvey.get(k)?.type ?? ''));
  const addedAnswers = survey.added.filter((k) => ANSWER_TYPES.test(surveyKeys(artifact.xlsForm.survey).get(k)?.type ?? ''));
  if (removedAnswers.length > 0 && addedAnswers.length > 0) {
    warnings.push(`Questions were both removed (${removedAnswers.join(', ')}) and added (${addedAnswers.join(', ')}); if any is a rename, data from earlier reports will not carry over.`);
  }
  for (const c of survey.changed) {
    if (c.columns.type) warnings.push(`Field '${c.key}' changed type from '${c.columns.type.before}' to '${c.columns.type.after}'.`);
  }
  if (outcomes.removed.length > 0) warnings.push(`Outcomes removed: ${outcomes.removed.join(', ')}.`);

  return {
    diffVersion: 1,
    baseline: {
      formId: baselineManifest.formId,
      inputHash: baselineManifest.inputHash,
      artifactHash: baselineManifest.artifactHash,
      snapshotHash: baselineManifest.snapshotHash ?? null,
    },
    current: { formId: m.formId, inputHash: m.inputHash, artifactHash: m.artifactHash, snapshotHash: m.snapshotHash },
    identical: baselineManifest.artifactHash === m.artifactHash,
    survey,
    choices,
    settings,
    outcomes,
    tasks,
    warnings,
  };
}
