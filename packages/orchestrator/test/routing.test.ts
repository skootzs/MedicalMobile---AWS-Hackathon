import assert from 'node:assert/strict';
import test from 'node:test';
import { routeDesignBrief } from '../src/routing.ts';
import type { DesignBrief } from '../src/routing.ts';

function example(): DesignBrief {
  return {
    requestId: 'fictional-workflow-001',
    title: 'Fictional community visit checklist',
    objective: 'Record completion of a training checklist.',
    targetPopulation: 'Fictional training households',
    screeningStatus: 'ASSESSED',
    requirements: [{ condition: 'Checklist completed', action: 'Show completion message' }],
    reviewFlags: { ambiguities: [], contradictions: [], clinicalSafetyConcerns: [] },
  };
}

test('complete fictional brief is ready only for Bedrock review', () => {
  const result = routeDesignBrief(example());
  assert.equal(result.route, 'READY_FOR_BEDROCK_REVIEW');
  assert.equal(result.requestId, 'fictional-workflow-001');
  assert.equal(result.reasons[0].code, 'READY_FOR_AI_REVIEW');
  assert.match(result.reasons[0].message, /human approvals are still required/);
});

for (const field of ['requestId', 'title', 'objective', 'targetPopulation', 'requirements', 'reviewFlags', 'screeningStatus']) {
  test(`missing ${field} needs designer review`, () => {
    const brief: Record<string, unknown> = { ...example() };
    delete brief[field];
    const result = routeDesignBrief(brief);
    assert.equal(result.route, 'NEEDS_SD_REVIEW');
    assert.ok(result.reasons.some(reason => reason.field === field));
    assert.equal(result.requestId, field === 'requestId' ? null : 'fictional-workflow-001');
  });
}

test('NOT_ASSESSED requires designer review even with empty findings', () => {
  const result = routeDesignBrief({ ...example(), screeningStatus: 'NOT_ASSESSED' });
  assert.equal(result.route, 'NEEDS_SD_REVIEW');
  assert.equal(result.requestId, 'fictional-workflow-001');
  assert.deepEqual(result.reasons.map(reason => [reason.code, reason.field]), [
    ['SCREENING_NOT_ASSESSED', 'screeningStatus'],
  ]);
});

test('missing screening status explains the missing information', () => {
  const brief: Record<string, unknown> = { ...example() };
  delete brief.screeningStatus;
  const result = routeDesignBrief(brief);
  assert.equal(result.route, 'NEEDS_SD_REVIEW');
  assert.ok(result.reasons.some(reason =>
    reason.code === 'MISSING_REQUIRED_INFORMATION' && reason.field === 'screeningStatus'));
});

test('malformed screening statuses fail closed without normalization', () => {
  for (const screeningStatus of [undefined, null, '', ' ', 'assessed', 'ASSESSED ', 'COMPLETE', true, 1, [], {}, { status: 'ASSESSED' }]) {
    const result = routeDesignBrief({ ...example(), screeningStatus });
    assert.equal(result.route, 'NEEDS_SD_REVIEW');
    assert.ok(result.reasons.some(reason => reason.field === 'screeningStatus'));
    if (screeningStatus !== undefined) {
      assert.ok(result.reasons.some(reason => reason.code === 'INVALID_INPUT'));
    }
  }
});

test('explicit ASSESSED allows AI review only when other checks pass', () => {
  assert.equal(routeDesignBrief(example()).route, 'READY_FOR_BEDROCK_REVIEW');
  for (const changes of [
    { objective: '' },
    { reviewFlags: null },
    { reviewFlags: [] },
    { reviewFlags: { ...example().reviewFlags, clinicalSafetyConcerns: ['Fictional training workflow needs review.'] } },
  ]) {
    assert.equal(routeDesignBrief({ ...example(), ...changes }).route, 'NEEDS_SD_REVIEW');
  }
});

for (const [flag, code] of Object.entries({
  ambiguities: 'AMBIGUITY', contradictions: 'CONTRADICTION', clinicalSafetyConcerns: 'CLINICAL_SAFETY_CONCERN',
})) {
  test(`reported ${flag} blocks automatic routing`, () => {
    const brief = example();
    const result = routeDesignBrief({
      ...brief,
      reviewFlags: { ...brief.reviewFlags, [flag]: ['Fictional checklist requires a reviewer clarification.'] },
    });
    assert.equal(result.route, 'NEEDS_SD_REVIEW');
    assert.ok(result.reasons.some(reason => reason.code === code));
  });
}

test('same condition with different actions requires clarification', () => {
  const brief = example();
  brief.requirements = [
    { condition: 'Checklist completed', action: 'Show completion message' },
    { condition: '  CHECKLIST   completed ', action: 'Show incomplete message' },
  ];
  const result = routeDesignBrief(brief);
  assert.equal(result.route, 'NEEDS_SD_REVIEW');
  assert.ok(result.reasons.some(reason => reason.code === 'CONTRADICTION'));
});

test('identical repeated requirements are consistent', () => {
  const brief = example();
  brief.requirements = [...brief.requirements, ...brief.requirements];
  assert.equal(routeDesignBrief(brief).route, 'READY_FOR_BEDROCK_REVIEW');
});

test('malformed inputs and incomplete screening fail closed', () => {
  const brief = example();
  for (const input of [
    null, undefined, 'checklist', [], 42, {},
    { ...brief, title: '  ' },
    { ...brief, requestId: 42 },
    { ...brief, requirements: [] },
    { ...brief, requirements: [null] },
    { ...brief, requirements: [{ condition: 'Complete', action: ' ' }] },
    { ...brief, requirements: new Array(1) },
    { ...brief, reviewFlags: {} },
    { ...brief, reviewFlags: { ...brief.reviewFlags, ambiguities: false } },
    { ...brief, reviewFlags: { ...brief.reviewFlags, ambiguities: [''] } },
    { ...brief, reviewFlags: { ...brief.reviewFlags, ambiguities: new Array(1) } },
  ]) {
    const result = routeDesignBrief(input);
    assert.equal(result.route, 'NEEDS_SD_REVIEW');
    assert.ok(result.reasons.length > 0);
  }
});

test('collects multiple reasons with field locations', () => {
  const brief = example();
  const result = routeDesignBrief({
    ...brief, title: '',
    reviewFlags: { ...brief.reviewFlags, ambiguities: ['Meaning of completion is unclear.'], clinicalSafetyConcerns: ['Training workflow needs clinician review.'] },
  });
  assert.equal(result.reasons.length, 3);
  assert.deepEqual(result.reasons.map(reason => reason.code), [
    'MISSING_REQUIRED_INFORMATION', 'AMBIGUITY', 'CLINICAL_SAFETY_CONCERN',
  ]);
  assert.ok(result.reasons.every(reason => reason.field && reason.message));
});

test('routing is repeatable and does not mutate input', () => {
  const brief = example();
  const original = structuredClone(brief);
  const first = routeDesignBrief(brief);
  assert.deepEqual(routeDesignBrief(brief), first);
  assert.deepEqual(brief, original);
});
