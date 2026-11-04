// Runs the compiled child_cough form and its follow-up task through cht-conf-test-harness.
// Needs a compiled project (compile with --template, then `cht compile-app-settings convert-app-forms`)
// and cht-conf-test-harness, mocha and chai installed where Node can find them.
//   CHT_PROJECT=/path/to/project TZ=Africa/Nairobi npx mocha test/harness/child-cough.spec.cjs --timeout 60000
const { expect } = require('chai');
const Harness = require('cht-conf-test-harness');

const directory = process.env.CHT_PROJECT;
if (!directory) throw new Error('Set CHT_PROJECT to the compiled project folder');

const harness = new Harness({ directory, headless: true });
const NOT_IN_PATHWAY = [['no']];
const NO_DANGER_SIGNS = ['no', 'no', 'no', 'no', 'no'];

describe('child_cough compiled form and follow-up task', () => {
  before(() => harness.start());
  after(() => harness.stop());
  beforeEach(async () => {
    await harness.clear();
    await harness.setNow('2026-11-04T10:00:00');
  });
  afterEach(() => expect(harness.consoleErrors).to.be.empty);

  it('classifies fast breathing at 24 months as pneumonia with a 3 day follow-up', async () => {
    const result = await harness.fillForm('child_cough', ['yes'], NO_DANGER_SIGNS, ['45', 'no', 'no']);
    expect(result.errors).to.be.empty;
    expect(result.report.fields).to.include({ classification: 'pneumonia', referral_urgent: 'no', follow_up_days: '3', in_scope: 'yes' });
  });

  it('classifies 39 breaths at 24 months as cough or cold', async () => {
    const result = await harness.fillForm('child_cough', ['yes'], NO_DANGER_SIGNS, ['39', 'no', 'no']);
    expect(result.errors).to.be.empty;
    expect(result.report.fields).to.include({ classification: 'cough_or_cold', follow_up_days: '5' });
  });

  it('refers a child with a danger sign urgently and raises no follow-up task', async () => {
    const result = await harness.fillForm('child_cough', ['yes'], ['no', 'no', 'yes', 'no', 'no'], ['30', 'no', 'no']);
    expect(result.errors).to.be.empty;
    expect(result.report.fields).to.include({ classification: 'severe_pneumonia_or_very_severe_disease', referral_urgent: 'yes', follow_up_days: '' });
    await harness.flush(3);
    expect(await harness.getTasks()).to.be.empty;
  });

  it('raises no task when the child has no cough', async () => {
    const result = await harness.fillForm('child_cough', ...NOT_IN_PATHWAY);
    expect(result.errors).to.be.empty;
    expect(result.report.fields).to.include({ classification: 'not_in_pathway' });
    await harness.flush(5);
    expect(await harness.getTasks()).to.be.empty;
  });

  it('shows the pneumonia follow-up task on day 3, until day 5, and resolves it with a new assessment', async () => {
    await harness.fillForm('child_cough', ['yes'], NO_DANGER_SIGNS, ['45', 'no', 'no']);

    await harness.flush(2);
    expect(await harness.getTasks(), 'not before the due date').to.be.empty;

    await harness.flush(1);
    const tasks = await harness.getTasks();
    expect(tasks).to.have.property('length', 1);
    expect(tasks[0].emission.title).to.equal('task.child_cough.follow_up.title');

    const followUp = await harness.loadAction(tasks[0], ['yes'], NO_DANGER_SIGNS, ['35', 'no', 'no']);
    expect(followUp.errors).to.be.empty;
    expect(followUp.report.fields).to.include({ classification: 'cough_or_cold' });
    const remaining = (await harness.getTasks()).filter((t) => t.emission.title === 'task.child_cough.follow_up.title' && t.emission.dueDate === tasks[0].emission.dueDate);
    expect(remaining, 'the first task is resolved').to.be.empty;
  });

  it('drops the task after the window closes', async () => {
    await harness.fillForm('child_cough', ['yes'], NO_DANGER_SIGNS, ['45', 'no', 'no']);
    await harness.flush(6);
    expect(await harness.getTasks()).to.be.empty;
  });
});
