// The issue poll against a fake GitHub: a labelled issue becomes a task, the issue hears what the task does, and a person answers on the issue.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-issue-poll-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#db/index.ts');
const { pollIssues } = await import('#application/landing/issues/poll.ts');
const { addTask, updateRepo } = await import('#application/actions.ts');
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
  const host: IssueHost = {
    whoami: async () => 'tom',
    openIssues: async (_cwd, label) => [...issues.values()].filter((i) => i.open && i.labels.includes(label)),
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
    close: async (_cwd, n, _reason, body) => {
      const i = issues.get(n);
      if (i) Object.assign(i, { open: false, closed_as: 'completed' });
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
    file,
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
});

test('agentdeck add is refused on an issue-backed repo', async () => {
  const { db, repo } = setup();
  await assert.rejects(addTask(db, { repo: repo.name, prompt: 'by hand' }), /takes its tasks from GitHub Issues/);
});

test('a label someone not allowed added is taken off with a comment, and nothing is queued', async () => {
  const { db, repo, gh } = setup();
  gh.file(8, {}, 'eve');
  await pollIssues(db);
  assert.equal(db.taskOfIssue(repo.id, 8), undefined);
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
