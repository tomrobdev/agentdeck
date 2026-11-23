// The issue poll against a fake GitHub: a labelled issue becomes a task and any other a proposal, the issue hears what the task does, and a person answers on the issue.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-issue-poll-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fakeClaude = join(import.meta.dirname, '../../fixtures/fake-claude.mjs');
chmodSync(fakeClaude, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fakeClaude;

const { openDb } = await import('#db/index.ts');
const { pollIssues } = await import('#application/landing/issues/poll.ts');
const { addTask, approveTask, editTask, liftTask, parkTask, proposeNow, rejectTask, taskDetail, updateRepo } =
  await import('#application/actions.ts');
const { advance, testApp } = await import('#test/fixtures/fixtures.ts');
const { fakeCodeHost } = await import('#test/fixtures/fakes.ts');

type IssueHost = Parameters<typeof testApp>[1] extends infer P ? (P extends { issues?: infer H } ? NonNullable<H> : never) : never;
type Issue = Awaited<ReturnType<IssueHost['openIssues']>>[number];
type Comment = Awaited<ReturnType<IssueHost['comments']>>[number];

function fakeIssues() {
  const issues = new Map<number, Issue>();
  const labelBy = new Map<number, string>();
  const comments = new Map<number, Comment[]>();
  const written: { number: number; body: string }[] = [];
  const closed: number[] = [];
  const labels = new Set<string>();
  const host: IssueHost = {
    whoami: async () => 'tom',
    ensureLabels: async (_cwd, want) => {
      for (const l of want) labels.add(l.name);
    },
    openIssues: async () => [...issues.values()].filter((i) => i.open),
    issue: async (_cwd, n) => issues.get(n) ?? null,
    comments: async (_cwd, n) => comments.get(n) ?? [],
    labelledBy: async (_cwd, n) => labelBy.get(n) ?? null,
    comment: async (_cwd, number, body) => {
      written.push({ number, body });
      comments.set(number, [
        ...(comments.get(number) ?? []),
        { author: 'tom', body, created_at: new Date(Date.now() + 1000).toISOString() },
      ]);
    },
    editLabels: async (_cwd, n, change) => {
      const i = issues.get(n);
      if (i) i.labels = [...i.labels.filter((l) => !change.remove.includes(l)), ...change.add];
    },
    create: async (_cwd, made) => {
      const number = Math.max(0, ...issues.keys()) + 1;
      file(number, { title: made.title, body: made.body, labels: made.labels });
      return `https://github.com/o/r/issues/${number}`;
    },
    close: async (_cwd, n, body, as) => {
      const i = issues.get(n);
      if (i) Object.assign(i, { open: false, closed_as: as });
      closed.push(n);
      written.push({ number: n, body });
    },
  };
  const file = (n: number, o: Partial<Issue> = {}, by = 'tom') => {
    issues.set(n, {
      number: n,
      url: `https://github.com/o/r/issues/${n}`,
      title: `Issue ${n}`,
      body: `## Current problem\nIssue ${n} is broken.\n\n## Expected outcome\n- It works.`,
      open: true,
      closed_as: null,
      labels: ['ready-for-agent'],
      blocked_by: [],
      parent: null,
      sub_issues: 0,
      ...o,
    });
    labelBy.set(n, by);
  };
  return {
    host,
    issues,
    comments,
    written,
    closed,
    labels,
    file,
    labelledAgain: (n: number, by: string) => labelBy.set(n, by),
    said: (n: number) => written.filter((w) => w.number === n).map((w) => w.body.replace('\n\n<!-- agentdeck -->', '')),
  };
}

let n = 0;
function setup() {
  const gh = fakeIssues();
  const db = testApp(openDb(join(home, `poll-${++n}.db`)), { issues: gh.host, codeHost: fakeCodeHost() });
  const repo = db.addRepo({ name: `koc-${n}`, path: join(home, `koc-${n}`), base_branch: 'develop' });
  updateRepo(db, repo.name, { issues: true, pr_mode: 'draft' });
  const taskOf = (number: number) => {
    const id = db.taskOfIssue(repo.id, number);
    assert.ok(id, `issue #${number} has a task`);
    return id;
  };
  return { db, repo, gh, taskOf };
}

test('a labelled issue becomes a queued task, once, and the issue is told its number', async () => {
  const { db, gh, taskOf } = setup();
  gh.file(7);
  await pollIssues(db);
  await pollIssues(db);
  const task = db.getTask(taskOf(7));
  assert.deepEqual([task?.status, task?.source, task?.title], ['queued', 'issue', 'Issue 7']);
  assert.deepEqual(gh.said(7), [`Queued as AgentDeck task #${task?.id}.`]);
  assert.deepEqual([...gh.labels].sort(), [
    'agentdeck:ignore',
    'agentdeck:parked',
    'agentdeck:plan',
    'agentdeck:running',
    'needs-info',
    'ready-for-agent',
    'ready-for-human',
  ]);
});

test('agentdeck add is refused on an issue-backed repo', async () => {
  const { db, repo } = setup();
  await assert.rejects(addTask(db, { repo: repo.name, prompt: 'by hand' }), /takes its tasks from GitHub Issues/);
});

test('a label someone not allowed added is taken off with a comment, and the issue is only a proposal', async () => {
  const { db, gh, taskOf } = setup();
  gh.file(8, {}, 'eve');
  await pollIssues(db);
  assert.equal(db.getTask(taskOf(8))?.status, 'proposed');
  assert.deepEqual(gh.issues.get(8)?.labels, []);
  assert.match(gh.said(8)[0] ?? '', /only when tom adds the ready-for-agent label, not eve/);
});

test('an issue blocked by one with no task waits; once the blocker has a task it builds on it', async () => {
  const { db, repo, gh, taskOf } = setup();
  gh.file(4, { blocked_by: [{ number: 3, open: true }] });
  await pollIssues(db);
  assert.equal(db.taskOfIssue(repo.id, 4), undefined);
  gh.file(3);
  await pollIssues(db);
  await pollIssues(db);
  assert.deepEqual(
    db.linksOf(taskOf(4)).map((l) => [l.on, l.kind]),
    [[taskOf(3), 'builds_on']],
  );
});

test('a question goes to the issue as needs-info; the label put back retries the task with the reply as its note', async () => {
  const { db, gh, taskOf } = setup();
  gh.file(5);
  await pollIssues(db);
  const id = taskOf(5);
  advance(db, id, 'blocked');
  db.recordQuestion(id, { question: 'Which table holds the wallet?', options: ['wallets', 'orders'] }, 'asked');
  await pollIssues(db);
  assert.deepEqual(gh.issues.get(5)?.labels, ['needs-info']);
  assert.match(gh.said(5).at(-1) ?? '', /Which table holds the wallet\?/);
  gh.comments.get(5)?.push({ author: 'tom', body: 'The wallets table.', created_at: new Date(Date.now() + 60_000).toISOString() });
  gh.issues.get(5)?.labels.push('ready-for-agent');
  await pollIssues(db);
  assert.equal(db.getTask(id)?.status, 'queued');
  assert.ok(
    db.eventsForTask(id).some((e) => e.type === 'retry' && e.reason === 'The wallets table.'),
    'the reply is the retry note',
  );
  assert.deepEqual(gh.issues.get(5)?.labels, ['ready-for-agent']);
});

test('a running task labels its issue; a merged PR closes the issue', async () => {
  const { db, gh, taskOf } = setup();
  gh.file(6);
  await pollIssues(db);
  const id = taskOf(6);
  advance(db, id, 'running');
  await pollIssues(db);
  assert.ok(gh.issues.get(6)?.labels.includes('agentdeck:running'));
  db.applyEvent(id, { type: 'finish', outcome: 'done' });
  db.recordPr(id, { type: 'opened', url: 'https://github.com/o/r/pull/9' });
  await pollIssues(db);
  assert.match(gh.said(6).at(-1) ?? '', /opened https:\/\/github\.com\/o\/r\/pull\/9/);
  db.recordPr(id, { type: 'seen', state: 'merged' });
  await pollIssues(db);
  assert.deepEqual(gh.closed, [6]);
  assert.equal(gh.said(6).at(-1), 'Merged in https://github.com/o/r/pull/9.');
  await pollIssues(db);
  assert.equal(gh.said(6).filter((s) => s.startsWith('Merged')).length, 1, 'the merge is told once');
});

test('removing the label from a queued issue cancels its task; editing the issue edits the task', async () => {
  const { db, gh, taskOf } = setup();
  gh.file(9);
  gh.file(10);
  await pollIssues(db);
  const issue10 = gh.issues.get(10);
  if (issue10) issue10.title = 'Issue ten, retitled';
  gh.issues.get(9)?.labels.splice(0);
  await pollIssues(db);
  assert.equal(db.getTask(taskOf(9))?.status, 'cancelled');
  assert.equal(db.getTask(taskOf(10))?.title, 'Issue ten, retitled');
});

test('the label put back by someone not allowed does not retry the task, and is taken off again', async () => {
  const { db, gh, taskOf } = setup();
  gh.file(11);
  await pollIssues(db);
  const id = taskOf(11);
  advance(db, id, 'blocked');
  db.recordQuestion(id, { question: 'Which table?', options: [] }, 'asked');
  await pollIssues(db);
  gh.issues.get(11)?.labels.push('ready-for-agent');
  gh.labelledAgain(11, 'eve');
  await pollIssues(db);
  assert.equal(db.getTask(id)?.status, 'blocked');
  assert.deepEqual(gh.issues.get(11)?.labels, ['needs-info']);
  assert.match(gh.said(11).at(-1) ?? '', /not eve/);
});

test('a parent labelled agentdeck:plan becomes a plan: its sub-issues land on its plan branch, and its plan PR merging closes it', async () => {
  const { db, repo, gh, taskOf } = setup();
  const sub = { parent: { number: 30, title: 'Phase 3', body: '' } };
  gh.file(30, { labels: [], title: 'Phase 3', body: 'The compliance fixes.\n\n## Wallets\n\n## Orders', sub_issues: 2 });
  gh.file(31, sub);
  await pollIssues(db);
  assert.equal(db.getTask(taskOf(31))?.target, null, 'a parent with no plan label behaves as today');
  gh.issues.get(30)?.labels.push('agentdeck:plan');
  gh.file(32, sub);
  await pollIssues(db);
  const owner = taskOf(30);
  const branch = db.planBranchOf(owner, repo.id);
  assert.equal(branch?.name, `plan/${owner}-phase-3`);
  assert.equal(branch?.base, 'develop');
  assert.equal(db.findRepo(repo.name)?.base_branch, 'develop', "the repo's base never changes");
  assert.equal(db.getTask(owner)?.status, 'parked');
  assert.equal(db.ownPlan(owner)?.html.match(/data-plan-step id="(\w+)"/g)?.length, 2);
  for (const n of [31, 32]) {
    const t = db.getTask(taskOf(n));
    assert.deepEqual([t?.status, t?.target, t?.plan?.task], ['queued', branch?.name, owner], `#${n} follows the plan on its branch`);
  }
  assert.match(gh.said(30).at(-1) ?? '', new RegExp(`Opened as AgentDeck plan #${owner}`));

  for (const [i, n] of [31, 32].entries()) {
    const id = taskOf(n);
    advance(db, id, 'running');
    db.applyEvent(id, { type: 'finish', outcome: 'done' });
    db.recordPr(id, { type: 'opened', url: `https://github.com/o/r/pull/${i + 1}` });
    db.recordPr(id, { type: 'seen', state: 'merged' });
  }
  await pollIssues(db);
  assert.deepEqual(gh.closed, [31, 32], 'each sub-issue closes when its own PR merges');
  assert.ok(branch);
  db.cutPlanBranch(branch.id, 'abc123');
  db.openPlanBranchPr(branch.id, 'https://github.com/o/r/pull/9');
  await pollIssues(db);
  assert.equal(gh.said(30).at(-1), `plan/${owner}-phase-3 opened its plan PR into develop: https://github.com/o/r/pull/9`);
  db.recordLanding(branch.id, { move: 'land', land_error: null });
  await pollIssues(db);
  await pollIssues(db);
  assert.deepEqual(gh.closed, [31, 32, 30]);
  assert.deepEqual(gh.said(30).filter((s) => s === 'Merged in https://github.com/o/r/pull/9.').length, 1);
});

test('taking agentdeck:plan off a parent before anything started abandons its plan branch and moves its tasks back', async () => {
  const { db, repo, gh, taskOf } = setup();
  gh.file(40, { labels: ['agentdeck:plan'], title: 'Phase 4' });
  gh.file(41, { parent: { number: 40, title: 'Phase 4', body: '' } });
  await pollIssues(db);
  const owner = taskOf(40);
  assert.equal(db.getTask(taskOf(41))?.target, `plan/${owner}-phase-4`);
  gh.issues.get(40)?.labels.splice(0);
  await pollIssues(db);
  assert.equal(db.planBranchOf(owner, repo.id)?.status, 'abandoned');
  assert.equal(db.getTask(taskOf(41))?.target, null);
  assert.equal(db.getTask(owner)?.status, 'cancelled');
  assert.match(gh.said(40).at(-1) ?? '', /lost the agentdeck:plan label .* abandoned/);
});

test('proposed sub-issues that build on each other move onto the plan branch together, still proposed, and know their parent', async () => {
  const { db, repo, gh, taskOf } = setup();
  const sub = { labels: [], parent: { number: 60, title: 'Phase 6', body: '' } };
  gh.file(60, { labels: [], title: 'Phase 6', sub_issues: 2 });
  gh.file(61, sub);
  gh.file(62, { ...sub, blocked_by: [{ number: 61, open: true }] });
  await pollIssues(db);
  assert.deepEqual([db.issueOf(taskOf(62))?.parent_number, db.issueOf(taskOf(62))?.parent_title], [60, 'Phase 6']);
  const before = (await taskDetail(db, taskOf(62))).merges_into;
  assert.deepEqual(before, { branch: 'develop', plan: null });

  gh.issues.get(60)?.labels.push('agentdeck:plan');
  await pollIssues(db);
  const owner = taskOf(60);
  for (const n of [61, 62]) {
    const t = db.getTask(taskOf(n));
    assert.deepEqual([t?.status, t?.target, t?.plan?.task], ['proposed', db.planBranchOf(owner, repo.id)?.name, owner]);
  }
  const view = await taskDetail(db, taskOf(62));
  assert.deepEqual(view.issue, { number: 62, url: 'https://github.com/o/r/issues/62', parent: { number: 60, title: 'Phase 6' } });
  assert.deepEqual(view.merges_into, {
    branch: `plan/${owner}-phase-6`,
    plan: { task: owner, base: 'develop' },
  });

  Object.assign(gh.issues.get(62) ?? {}, { parent: null });
  await pollIssues(db);
  assert.equal(db.issueOf(taskOf(62))?.parent_number, null, 'taken out of its parent on GitHub');
});

test("a sub-issue's task carries its parent's body, which gh's issue list leaves out", async () => {
  const { db, gh, taskOf } = setup();
  gh.file(20, { labels: [], body: 'Phase 3: the compliance fixes.' });
  gh.file(21, { parent: { number: 20, title: 'Phase 3', body: '' } });
  await pollIssues(db);
  assert.match(db.getTask(taskOf(21))?.prompt ?? '', /This is part of #20, Issue 20\.\n\nPhase 3: the compliance fixes\./);
});

test('an open issue no one labelled becomes a proposal once, follows edits, and a close drops it without a word', async () => {
  const { db, repo, gh, taskOf } = setup();
  gh.file(40, { labels: ['needs-triage'] });
  gh.file(41, { labels: ['ready-for-human'] });
  gh.file(42, { labels: [], sub_issues: 2 });
  await pollIssues(db);
  await pollIssues(db);
  const id = taskOf(40);
  assert.deepEqual([db.getTask(id)?.status, db.getTask(id)?.source], ['proposed', 'issue']);
  assert.equal(db.issueOf(id)?.reported, 'proposed');
  assert.equal(db.taskOfIssue(repo.id, 41), undefined, "a person's issue stays out");
  assert.equal(db.taskOfIssue(repo.id, 42), undefined, 'a parent of sub-issues stays out');
  assert.deepEqual(gh.said(40), [], 'a proposal tells the issue nothing');

  const issue = gh.issues.get(40);
  assert.ok(issue);
  issue.title = 'Fill the pool';
  await pollIssues(db);
  assert.equal(db.getTask(id)?.title, 'Fill the pool');

  Object.assign(issue, { open: false, closed_as: 'completed' });
  await pollIssues(db);
  assert.equal(db.getTask(id)?.status, 'cancelled');
  assert.equal(db.taskOfIssue(repo.id, 40), undefined, 'a dropped proposal lets go of its issue');
  assert.deepEqual(gh.said(40), []);
  Object.assign(issue, { open: true, closed_as: null });
  await pollIssues(db);
  assert.equal(db.getTask(taskOf(40))?.status, 'proposed', 'reopened, it is proposed again');
});

test('approve, park, lift and reject in AgentDeck write back to the issue, once each', async () => {
  const { db, gh, taskOf } = setup();
  gh.file(50, { labels: [] });
  gh.file(51, { labels: [] });
  await pollIssues(db);
  const a = taskOf(50);
  const b = taskOf(51);

  approveTask(db, a);
  await pollIssues(db);
  await pollIssues(db);
  assert.equal(db.getTask(a)?.status, 'queued', 'not cancelled for the label it had not been given yet');
  assert.deepEqual(gh.issues.get(50)?.labels, ['ready-for-agent']);
  assert.deepEqual(gh.said(50), [`Approved in AgentDeck and queued as task #${a}.`]);

  parkTask(db, b, 'after phase 3');
  await pollIssues(db);
  assert.deepEqual(gh.issues.get(51)?.labels, ['agentdeck:parked']);
  assert.match(gh.said(51).at(-1) ?? '', /parked in AgentDeck: after phase 3/);
  liftTask(db, b);
  await pollIssues(db);
  assert.deepEqual(gh.issues.get(51)?.labels, []);
  assert.match(gh.said(51).at(-1) ?? '', /lifted in AgentDeck/);
  rejectTask(db, b);
  await pollIssues(db);
  await pollIssues(db);
  assert.deepEqual([gh.issues.get(51)?.open, gh.issues.get(51)?.closed_as], [false, 'not_planned']);
  assert.equal(gh.said(51).filter((s) => /rejected in AgentDeck/.test(s)).length, 1);
});

test("the ready label from an allowed login approves a proposal; a stranger's comes off; on a parked one it is refused", async () => {
  const { db, gh, taskOf } = setup();
  gh.file(60, { labels: [] });
  gh.file(61, { labels: [] });
  gh.file(62, { labels: [] });
  await pollIssues(db);
  parkTask(db, taskOf(62));
  await pollIssues(db);

  gh.issues.get(60)?.labels.push('ready-for-agent');
  gh.issues.get(61)?.labels.push('ready-for-agent');
  gh.labelledAgain(61, 'eve');
  gh.issues.get(62)?.labels.push('ready-for-agent');
  await pollIssues(db);

  assert.equal(db.getTask(taskOf(60))?.status, 'queued');
  assert.match(gh.said(60).at(-1) ?? '', /queued as task/);
  assert.equal(db.getTask(taskOf(61))?.status, 'proposed');
  assert.deepEqual(gh.issues.get(61)?.labels, []);
  assert.match(gh.said(61).at(-1) ?? '', /not eve/);
  assert.equal(db.getTask(taskOf(62))?.status, 'parked');
  assert.deepEqual(gh.issues.get(62)?.labels, ['agentdeck:parked']);
  assert.match(gh.said(62).at(-1) ?? '', /Lift it there first/);
});

test("an issue's task is edited on GitHub: its title and prompt are refused in AgentDeck, the rest changes", async () => {
  const { db, gh, taskOf } = setup();
  gh.file(70, { labels: [] });
  await pollIssues(db);
  const id = taskOf(70);
  await assert.rejects(
    editTask(db, id, { prompt: 'by hand' }),
    /come from issue #70: edit the issue \(https:\/\/github.com\/o\/r\/issues\/70\)/,
  );
  await assert.rejects(editTask(db, id, { title: 'by hand' }), /come from issue #70/);
  assert.equal((await editTask(db, id, { priority: 2 })).priority, 2);
});

test("a verify run's findings are commented on the issue once; the next verify run comments its own", async () => {
  const { db, gh, taskOf } = setup();
  gh.file(80, { labels: [] });
  await pollIssues(db);
  const id = taskOf(80);
  const findings = [{ claim: 'it is broken', verdict: 'stale', path: 'a.ts', line: 1, evidence: 'Fixed in #12.', fix: 'Drop it.' }];
  const verify = () => {
    const run = db.startRun(id, 0, join(home, `verify-${id}.log`), 'verify');
    db.finishRun(run, { outcome: 'done', result_text: JSON.stringify({ findings }), ended_at: new Date().toISOString() });
  };
  verify();
  await pollIssues(db);
  await pollIssues(db);
  assert.equal(gh.said(80).filter((s) => s.startsWith('A verify run')).length, 1);
  assert.match(gh.said(80).at(-1) ?? '', /1 claim: 1 stale/);
  verify();
  await pollIssues(db);
  assert.equal(gh.said(80).filter((s) => s.startsWith('A verify run')).length, 2);
});

test('the planner opens issues on an issue-backed repo, and the next poll makes them proposals', async () => {
  const { db, repo, gh, taskOf } = setup();
  mkdirSync(repo.path, { recursive: true });
  updateRepo(db, repo.name, { goals: '# Goals\n- greet people' });
  const res = await proposeNow(db, repo.name);
  assert.deepEqual([res.outcome, res.tasks.length], ['proposed', 0]);
  assert.ok(gh.issues.size >= 2, 'one issue per proposal');
  assert.equal(db.tasksForRepo(repo.id, 10).length, 0, 'no task until the poll');
  const [first] = [...gh.issues.values()];
  assert.match(first?.body ?? '', /Proposed by AgentDeck's planner/);
  assert.deepEqual(first?.labels, []);
  await pollIssues(db);
  for (const n of gh.issues.keys()) assert.equal(db.getTask(taskOf(n))?.status, 'proposed');
});

test('an auto-approving issue-backed repo labels the issues its planner opens; a planner with nothing to propose opens none', async () => {
  const { db, repo, gh, taskOf } = setup();
  mkdirSync(repo.path, { recursive: true });
  updateRepo(db, repo.name, { goals: '# Goals\n- greet people', auto_approve: true });
  await proposeNow(db, repo.name);
  const made = [...gh.issues.values()];
  assert.ok(made.length && made.every((i) => i.labels.includes('ready-for-agent')));
  await pollIssues(db);
  assert.equal(db.getTask(taskOf(made[0]?.number ?? 0))?.status, 'queued');

  const empty = setup();
  mkdirSync(empty.repo.path, { recursive: true });
  updateRepo(empty.db, empty.repo.name, { goals: '# Goals\n- FAKE_PLAN_EMPTY' });
  const res = await proposeNow(empty.db, empty.repo.name);
  assert.deepEqual([res.outcome, res.note, empty.gh.issues.size], ['nothing', 'goals already met', 0]);
});

test('a proposal whose issue is labelled agentdeck:plan gives way to the plan, with its page', async () => {
  const { db, repo, gh, taskOf } = setup();
  gh.file(90, { labels: [], title: 'Phase 4', body: 'Why.\n\n## Wallets\n\n## Orders' });
  await pollIssues(db);
  const proposal = taskOf(90);
  gh.issues.get(90)?.labels.push('agentdeck:plan');
  await pollIssues(db);
  const owner = taskOf(90);
  assert.notEqual(owner, proposal);
  assert.equal(db.getTask(proposal)?.status, 'cancelled');
  assert.equal(db.getTask(owner)?.status, 'parked');
  assert.ok(db.ownPlan(owner), 'the plan has its page');
  assert.equal(db.planBranchOf(owner, repo.id)?.name, `plan/${owner}-phase-4`);
});
