// A parent issue as a plan, as pure decisions: its body as the plan's page, who may label it, and what it is told as its plan branch moves.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '#domain/shared/index.ts';
import { type Issue, duePlanIssueWrite, isFinalReport, parsePlan, planIntake, planOwnerParkReason } from '#domain/work/index.ts';

const parent = (o: Partial<Issue> = {}): Issue => ({
  number: 20,
  url: 'https://github.com/o/r/issues/20',
  title: 'Phase 3: compliance <fixes>',
  body: 'Fix what the audit found.\n\nMore detail.\n\n## Wallets\n- [ ] one\n- [x] two\n\n## Orders\n```\n## not a step\n```\n',
  open: true,
  closed_as: null,
  labels: ['agentdeck:plan'],
  blocked_by: [],
  parent: null,
  sub_issues: 0,
  ...o,
});

const owner = asTaskId(40);
const branch = { name: 'plan/40-phase-3', base: 'develop', status: 'open' as const, pr_url: null };

test("a parent issue's body becomes a plan page: its headings the steps, its first paragraph the summary", () => {
  const intake = planIntake(parent(), { labelledBy: 'tom', allowed: ['tom'] });
  assert.equal(intake.kind, 'add');
  const html = intake.kind === 'add' ? intake.html : '';
  const plan = parsePlan(html);
  assert.equal(plan?.title, 'Phase 3: compliance <fixes>');
  assert.equal(plan?.summary, 'Fix what the audit found.');
  assert.deepEqual(
    plan?.steps.map((s) => [s.id, s.title, s.status]),
    [
      ['wallets', 'Wallets', 'todo'],
      ['orders', 'Orders', 'todo'],
    ],
  );
  assert.match(html, /<li>one<\/li><li>two<\/li>/);
  assert.match(html, /<pre><code>## not a step<\/code><\/pre>/);
  assert.match(html, /&lt;fixes&gt;/);
});

test('a parent issue with no headings is a plan of one step, and one labelled by someone not allowed is refused', () => {
  const one = planIntake(parent({ body: '' }), { labelledBy: 'tom', allowed: ['tom'] });
  const plan = parsePlan(one.kind === 'add' ? one.html : '');
  assert.equal(plan?.steps.length, 1);
  assert.match(plan?.summary ?? '', /its sub-issues are its tasks/);
  assert.equal(one.kind === 'add' ? one.prompt : '', 'Phase 3: compliance <fixes>');
  const refused = planIntake(parent(), { labelledBy: 'eve', allowed: ['tom'] });
  assert.match(refused.kind === 'refuse' ? refused.comment : '', /adds the agentdeck:plan label, not eve/);
  assert.match(planOwnerParkReason(20), /plan of issue #20/);
});

test('the parent hears its plan opened, its plan PR opened and merged, each once and in order', () => {
  const open = duePlanIssueWrite(owner, parent(), branch, null);
  assert.equal(open?.to, 'plan_open');
  assert.match(open?.comment ?? '', /plan #40.*plan\/40-phase-3/);
  assert.equal(duePlanIssueWrite(owner, parent(), { ...branch, status: 'active' }, 'plan_open'), null);
  const pr = duePlanIssueWrite(owner, parent(), { ...branch, status: 'landing', pr_url: 'https://github.com/o/r/pull/5' }, 'plan_open');
  assert.equal(pr?.to, 'plan_pr_open');
  assert.equal(duePlanIssueWrite(owner, parent(), { ...branch, status: 'active', pr_url: 'x' }, 'plan_pr_open'), null);
  const merged = duePlanIssueWrite(
    owner,
    parent(),
    { ...branch, status: 'landed', pr_url: 'https://github.com/o/r/pull/5' },
    'plan_pr_open',
  );
  assert.deepEqual(merged, { to: 'plan_merged', comment: 'Merged in https://github.com/o/r/pull/5.', close: true, abandon: false });
  assert.equal(duePlanIssueWrite(owner, parent(), { ...branch, status: 'landed', pr_url: null }, 'plan_merged'), null);
  assert.deepEqual([isFinalReport('plan_merged'), isFinalReport('plan_abandoned'), isFinalReport('plan_open')], [true, true, false]);
});

test('the plan label taken off, or the parent closed, abandons a plan branch nothing has started on, and only then', () => {
  const unlabelled = duePlanIssueWrite(owner, parent({ labels: [] }), branch, 'plan_open');
  assert.deepEqual([unlabelled?.to, unlabelled?.abandon], ['plan_abandoned', true]);
  assert.match(unlabelled?.comment ?? '', /lost the agentdeck:plan label/);
  assert.match(duePlanIssueWrite(owner, parent({ open: false }), branch, 'plan_open')?.comment ?? '', /was closed/);
  assert.equal(duePlanIssueWrite(owner, parent({ labels: [] }), { ...branch, status: 'active' }, 'plan_open'), null);
  const byPerson = duePlanIssueWrite(owner, parent(), { ...branch, status: 'abandoned' }, 'plan_open');
  assert.deepEqual([byPerson?.to, byPerson?.abandon], ['plan_abandoned', false]);
});
