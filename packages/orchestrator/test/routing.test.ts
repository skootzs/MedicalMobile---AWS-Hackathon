import assert from 'node:assert/strict';
import test from 'node:test';
import { routeDesignBrief, screeningAreas } from '../src/routing.ts';
import type { RoutingInput } from '../src/routing.ts';

// Fixed fictional fingerprints are test fixtures, not computed production hashes.
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
function example(): RoutingInput {
  const identity = { requestId: 'fictional-training-001', revision: 2, snapshotHash: HASH };
  return {
    currentRevision: { ...identity }, currentScreeningId: 'screening-002',
    brief: { ...identity, title: 'Fictional training checklist', objective: 'Record checklist completion.',
      targetPopulation: 'Fictional training households',
      requirements: [{ condition: 'Checklist completed', action: 'Show completion message' }] },
    screening: { ...identity, screeningId: 'screening-002', status: 'COMPLETED', checks: {
      completeness: { outcome: 'CLEAR', reasons: [] }, ambiguities: { outcome: 'CLEAR', reasons: [] },
      contradictions: { outcome: 'CLEAR', reasons: [] }, clinicalSafety: { outcome: 'CLEAR', reasons: [] },
      feasibility: { outcome: 'CLEAR', reasons: [] },
    } },
    confirmation: { ...identity, confirmationId: 'confirmation-002', screeningId: 'screening-002', decision: 'CONFIRMED' },
  };
}
function notReady(input: unknown, code?: string) {
  const result = routeDesignBrief(input);
  assert.equal(result.route, 'NOT_READY');
  assert.equal(result.clinicalApprovalRequired, true);
  assert.ok(result.reasons.length > 0);
  if (code) assert.ok(result.reasons.some(reason => reason.code === code));
  return result;
}

test('matching current evidence and all five clear assessments allow downstream routing only', () => {
  const result = routeDesignBrief(example());
  assert.equal(result.route, 'READY_FOR_BEDROCK_REVIEW');
  assert.equal(result.requestId, 'fictional-training-001');
  assert.equal(result.revision, 2);
  assert.equal(result.snapshotHash, HASH);
  assert.equal(result.screeningId, 'screening-002');
  assert.equal(result.confirmationId, 'confirmation-002');
  assert.equal(result.clinicalApprovalRequired, true);
  assert.match(result.reasons[0].message, /scheduled separately/);
});

for (const field of ['currentRevision', 'currentScreeningId', 'brief', 'screening', 'confirmation']) {
  test(`missing ${field} is ineligible, not SD work`, () => {
    const input: Record<string, unknown> = { ...example() };
    delete input[field];
    notReady(input);
  });
}
for (const field of ['brief', 'screening', 'confirmation'] as const) {
  for (const [key, value] of Object.entries({ requestId: 'other-request', revision: 1, snapshotHash: OTHER_HASH })) {
    test(`${field} with different ${key} is stale`, () => {
      const input = example();
      Object.assign(input[field], { [key]: value });
      notReady(input, 'STALE_EVIDENCE');
    });
  }
}
test('mutually matching old evidence is rejected against authoritative current revision', () => {
  const input = example();
  input.currentRevision.revision = 3;
  input.currentRevision.snapshotHash = OTHER_HASH;
  notReady(input, 'STALE_EVIDENCE');
});
test('missing or malformed identities fail closed without inventing values', () => {
  for (const key of ['requestId', 'revision', 'snapshotHash']) {
    for (const value of [undefined, null, '', [], {}, true]) {
      const input = example();
      Object.assign(input.currentRevision, { [key]: value });
      const result = notReady(input, 'INVALID_INPUT');
      assert.equal(result[key as 'requestId' | 'revision' | 'snapshotHash'], null);
    }
  }
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2']) {
    notReady({ ...example(), currentRevision: { ...example().currentRevision, revision: value } });
  }
  for (const value of ['fake-hash', 'A'.repeat(64), 'a'.repeat(63)]) {
    notReady({ ...example(), currentRevision: { ...example().currentRevision, snapshotHash: value } });
  }
});
for (const status of ['PENDING', 'FAILED', undefined, 'ASSESSED', 'completed', true]) {
  test(`screening status ${String(status)} is not eligible`, () => {
    const input = example();
    notReady({ ...input, screening: { ...input.screening, status } });
  });
}
test('revision requested or malformed confirmation cannot route', () => {
  for (const decision of ['REVISION_REQUESTED', undefined, 'confirmed', true]) {
    const input = example();
    notReady({ ...input, confirmation: { ...input.confirmation, decision } }, 'PO_NOT_CONFIRMED');
  }
});
test('PO confirmation for a different screening attempt is blocked', () => {
  const input = example(); input.confirmation.screeningId = 'old-screening';
  notReady(input, 'CONFLICTING_EVIDENCE');
});
test('superseded screening is blocked even if PO confirmed it', () => {
  const input = example(); input.currentScreeningId = 'newer-screening';
  notReady(input, 'CONFLICTING_EVIDENCE');
});
test('missing or invalid evidence IDs cannot establish eligibility', () => {
  for (const value of [undefined, '', ' ', 1]) {
    const input = example();
    notReady({ ...input, confirmation: { ...input.confirmation, confirmationId: value } });
    notReady({ ...input, screening: { ...input.screening, screeningId: value } });
    notReady({ ...input, confirmation: { ...input.confirmation, screeningId: value } });
  }
});
for (const area of screeningAreas) {
  test(`unresolved ${area} routes eligible request to SD`, () => {
    const input = example();
    input.screening.checks[area] = { outcome: 'NEEDS_REVIEW', reasons: ['Fictional follow-up timing needs clarification.'] };
    const result = routeDesignBrief(input);
    assert.equal(result.route, 'NEEDS_SD_REVIEW');
    assert.equal(result.clinicalApprovalRequired, true);
    assert.equal(result.reasons[0].field, `screening.checks.${area}`);
  });
  test(`missing, unassessed, or malformed ${area} is ineligible`, () => {
    for (const assessment of [undefined, null, [], { outcome: 'NOT_ASSESSED', reasons: [] },
      { outcome: 'unknown', reasons: [] }, { outcome: 'CLEAR' },
      { outcome: 'CLEAR', reasons: [''] }, { outcome: 'CLEAR', reasons: new Array(1) }]) {
      const input = example();
      notReady({ ...input, screening: { ...input.screening, checks: { ...input.screening.checks, [area]: assessment } } });
    }
  });
}
test('contradictory assessment outcomes and reasons are blocked', () => {
  for (const assessment of [{ outcome: 'CLEAR', reasons: ['A concern exists.'] }, { outcome: 'NEEDS_REVIEW', reasons: [] }]) {
    const input = example();
    notReady({ ...input, screening: { ...input.screening, checks: { ...input.screening.checks, clinicalSafety: assessment } } }, 'CONFLICTING_EVIDENCE');
  }
});
test('unknown assessment areas and multiple candidate records fail closed', () => {
  const input = example();
  notReady({ ...input, screening: [input.screening, input.screening] });
  notReady({ ...input, screening: { ...input.screening, checks: { ...input.screening.checks, extra: { outcome: 'NEEDS_REVIEW', reasons: ['Unknown concern.'] } } } });
});
test('invalid prerequisites take precedence over a clinical finding', () => {
  const input = example();
  input.screening.checks.clinicalSafety = { outcome: 'NEEDS_REVIEW', reasons: ['Fictional clinical review needed.'] };
  input.confirmation.decision = 'REVISION_REQUESTED';
  notReady(input, 'PO_NOT_CONFIRMED');
});
for (const field of ['title', 'objective', 'targetPopulation', 'requirements']) {
  test(`eligible request with missing workflow ${field} needs clarification`, () => {
    const input = example();
    const brief: Record<string, unknown> = { ...input.brief }; delete brief[field];
    const result = routeDesignBrief({ ...input, brief });
    assert.equal(result.route, 'NEEDS_SD_REVIEW');
    assert.ok(result.reasons.some(reason => reason.code === 'MISSING_REQUIRED_INFORMATION'));
  });
}
test('empty, sparse, or malformed requirements need SD after eligibility', () => {
  for (const requirements of [[], new Array(1), [null], [{ condition: 'Complete', action: ' ' }]]) {
    const input = example();
    assert.equal(routeDesignBrief({ ...input, brief: { ...input.brief, requirements } }).route, 'NEEDS_SD_REVIEW');
  }
});
test('same condition with different actions still flags contradiction', () => {
  const input = example();
  input.brief.requirements = [{ condition: 'Checklist completed', action: 'Show complete' }, { condition: ' Checklist   completed ', action: 'Show incomplete' }];
  const result = routeDesignBrief(input);
  assert.equal(result.route, 'NEEDS_SD_REVIEW');
  assert.ok(result.reasons.some(reason => reason.code === 'CONTRADICTION'));
});
test('case-sensitive action identifiers are not silently equated', () => {
  const input = example();
  input.brief.requirements = [{ condition: 'Completed', action: 'Set fieldA' }, { condition: 'Completed', action: 'Set fielda' }];
  assert.equal(routeDesignBrief(input).route, 'NEEDS_SD_REVIEW');
});
test('identical duplicate requirements remain consistent', () => {
  const input = example(); input.brief.requirements = [...input.brief.requirements, ...input.brief.requirements];
  assert.equal(routeDesignBrief(input).route, 'READY_FOR_BEDROCK_REVIEW');
});
test('legacy brief or browser trust flag is not authoritative evidence', () => {
  notReady({ ...example().brief, screeningStatus: 'ASSESSED', trusted: true });
});
test('malformed envelopes fail closed', () => {
  for (const input of [null, undefined, [], 42, 'request', {}]) notReady(input);
});
test('multiple unresolved findings are retained with field locations', () => {
  const input = example();
  input.screening.checks.ambiguities = { outcome: 'NEEDS_REVIEW', reasons: ['Fictional timing unclear.', 'Fictional visit type unclear.'] };
  const result = routeDesignBrief(input);
  assert.equal(result.route, 'NEEDS_SD_REVIEW');
  assert.equal(result.reasons.length, 2);
  assert.ok(result.reasons.every(reason => reason.field && reason.message));
});
test('decisions are deterministic and do not mutate records', () => {
  const input = example(); const before = structuredClone(input);
  assert.deepEqual(routeDesignBrief(input), routeDesignBrief(input));
  assert.deepEqual(input, before);
});
test('no outcome grants clinical approval or release permission', () => {
  for (const route of ['NOT_READY', 'NEEDS_SD_REVIEW', 'READY_FOR_BEDROCK_REVIEW']) {
    const input = example();
    if (route === 'NOT_READY') input.screening.status = 'PENDING';
    if (route === 'NEEDS_SD_REVIEW') input.screening.checks.clinicalSafety = { outcome: 'NEEDS_REVIEW', reasons: ['Clinician review needed.'] };
    const result = routeDesignBrief(input);
    assert.equal(result.route, route);
    assert.equal(result.clinicalApprovalRequired, true);
    assert.equal('approved' in result, false);
    assert.equal('releasePermission' in result, false);
  }
});
