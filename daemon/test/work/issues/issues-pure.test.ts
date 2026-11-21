// Issue-backed repos as pure decisions: reading gh's JSON, taking in a labelled issue, a person's change on it, and what the issue is told back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '#domain/shared/index.ts';
import {
  type Issue,
  type Task,
  dueIssueWrite,
  isAllowed,
  isFinalReport,
  issueIntake,
  issueMove,
  issueNote,
  issueRepoAddError,
  labelRefusal,
  signed,
  labelledBy,
  parseIssue,
  parseIssueComments,
  parseIssues,
  parseLabelNames,
} from '#domain/work/index.ts';

const issue = (o: Partial<Issue> = {}): Issue => ({
  number: 7,
  url: 'https://github.com/o/r/issues/7',
  title: 'Fill the ticket pool',
  body: '## Current problem\nThe pool is empty.\n\n## Expected outcome\n- It fills.',
  open: true,
  closed_as: null,
  labels: ['ready-for-agent'],
  blocked_by: [],
  parent: null,
  ...o,
});

const task = (o: Record<string, unknown> = {}): Task =>
  ({
    id: asTaskId(12),
    status: 'queued',
    title: 'Fill the ticket pool',
    prompt: '## Current problem\nThe pool is empty.\n\n## Expected outcome\n- It fills.',
    attempts: 1,
    max_attempts: 2,
    pr: null,
    ...o,
  }) as unknown as Task;

const none = () => undefined;

test('gh issue JSON reads into issues: labels, blockers as a list or nodes, a closed reason, a parent', () => {
  const [read] = parseIssues(
    JSON.stringify([
      {
        number: 4,
        url: 'u',
        title: 't',
        body: 'b',
        state: 'CLOSED',
        stateReason: 'NOT_PLANNED',
        labels: [{ name: 'ready-for-agent' }, { nope: 1 }],
        blockedBy: {
          nodes: [
            { number: 3, state: 'OPEN' },
            { number: 2, state: 'CLOSED' },
          ],
        },
        parent: { number: 1, title: 'Phase 3' },
      },
    ]),
  );
  assert.deepEqual(read, {
    number: 4,
    url: 'u',
    title: 't',
    body: 'b',
    open: false,
    closed_as: 'not_planned',
    labels: ['ready-for-agent'],
    blocked_by: [
      { number: 3, open: true },
      { number: 2, open: false },
    ],
    parent: { number: 1, title: 'Phase 3', body: '' },
  });
  assert.equal(parseIssue('{"number":5,"state":"OPEN","blockedBy":[{"number":1,"state":"OPEN"}]}')?.blocked_by[0]?.number, 1);
  assert.equal(parseIssue('not json'), null);
});

test('a list gh did not answer with a list throws, so the poll never reads it as no issues', () => {
  assert.throws(() => parseIssues('{"error":"rate limited"}'), /did not answer with a list/);
  assert.throws(() => parseIssues(''), /did not answer with a list/);
  assert.deepEqual(parseLabelNames('[{"name":"bug"},{"name":"needs-info"}]'), ['bug', 'needs-info']);
  assert.throws(() => parseLabelNames('{"message":"Not Found"}'), /did not answer with a list of labels/);
});

test('comments read with their author, and the last person to add a label is found in the timeline', () => {
  const comments = parseIssueComments(
    JSON.stringify({ comments: [{ author: { login: 'tom' }, body: 'yes', createdAt: '2026-11-21T10:00:00Z' }] }),
  );
  assert.deepEqual(comments, [{ author: 'tom', body: 'yes', created_at: '2026-11-21T10:00:00Z' }]);
  const timeline = JSON.stringify([
    { event: 'labeled', label: { name: 'ready-for-agent' }, actor: { login: 'bot' } },
    { event: 'labeled', label: { name: 'bug' }, actor: { login: 'eve' } },
    { event: 'labeled', label: { name: 'ready-for-agent' }, actor: { login: 'tom' } },
  ]);
  assert.equal(labelledBy(timeline, 'ready-for-agent'), 'tom');
  const pages = JSON.stringify([
    [{ event: 'labeled', label: { name: 'ready-for-agent' }, actor: { login: 'bot' } }],
    [{ event: 'labeled', label: { name: 'ready-for-agent' }, actor: { login: 'tom' } }],
  ]);
  assert.equal(labelledBy(pages, 'ready-for-agent'), 'tom', 'gh --paginate --slurp gives one array per page');
  assert.equal(labelledBy('[]', 'ready-for-agent'), null);
});

test('agentdeck add is refused on an issue-backed repo, naming the label', () => {
  assert.match(issueRepoAddError({ name: 'KingOfComps', issues: true }) ?? '', /takes its tasks from GitHub Issues.*ready-for-agent/);
  assert.equal(issueRepoAddError({ name: 'AgentDeck', issues: false }), null);
});

test('a labelled issue from an allowed login becomes a task; anyone else, or an empty body, is refused', () => {
  const add = issueIntake(issue(), { labelledBy: 'tom', allowed: ['tom'], taskOf: none });
  assert.deepEqual(add, { kind: 'add', title: 'Fill the ticket pool', prompt: issue().body, builds_on: [] });
  const refused = issueIntake(issue(), { labelledBy: 'eve', allowed: ['tom'], taskOf: none });
  assert.equal(refused.kind, 'refuse');
  assert.match(refused.kind === 'refuse' ? refused.comment : '', /only when tom adds the ready-for-agent label, not eve/);
  assert.equal(issueIntake(issue(), { labelledBy: 'Tom', allowed: ['tom'], taskOf: none }).kind, 'add');
  const empty = issueIntake(issue({ body: ' ' }), { labelledBy: 'tom', allowed: ['tom'], taskOf: none });
  assert.match(empty.kind === 'refuse' ? empty.comment : '', /no body/);
});

test('a login is allowed whatever its case, and no login never is', () => {
  assert.equal(isAllowed(['TomRobDev'], 'tomrobdev'), true);
  assert.equal(isAllowed(['tom'], 'eve'), false);
  assert.equal(isAllowed(['tom'], null), false);
  assert.match(labelRefusal([], null), /only when a listed login adds the ready-for-agent label, so/);
});

test('an open blocker with a task becomes a builds-on link; one with no task yet makes the issue wait; a closed one is met', () => {
  const blocked = issue({
    blocked_by: [
      { number: 3, open: true },
      { number: 2, open: false },
    ],
  });
  const taskOf = (n: number) => (n === 3 ? asTaskId(30) : undefined);
  const add = issueIntake(blocked, { labelledBy: 'tom', allowed: ['tom'], taskOf });
  assert.deepEqual(add.kind === 'add' ? add.builds_on : null, [30]);
  const wait = issueIntake(blocked, { labelledBy: 'tom', allowed: ['tom'], taskOf: none });
  assert.deepEqual(wait, { kind: 'wait', reason: 'blocked by #3, which has no task yet' });
});

test("a sub-issue's prompt carries its parent's title and body as context", () => {
  const add = issueIntake(issue({ parent: { number: 1, title: 'Phase 3', body: 'Compliance fixes.' } }), {
    labelledBy: 'tom',
    allowed: ['tom'],
    taskOf: none,
  });
  assert.match(add.kind === 'add' ? add.prompt : '', /## Context\nThis is part of #1, Phase 3\.\n\nCompliance fixes\.$/);
});

test('a queued task follows its issue: an edit updates it, a removed label or a close cancels it', () => {
  assert.deepEqual(issueMove(task(), issue(), { reported: 'queued' }), { kind: 'none' });
  assert.deepEqual(issueMove(task(), issue({ title: 'Fill the pool' }), { reported: 'queued' }).kind, 'edit');
  assert.deepEqual(issueMove(task(), issue({ labels: [] }), { reported: 'queued' }).kind, 'cancel');
  assert.deepEqual(issueMove(task(), issue({ open: false, closed_as: 'completed' }), { reported: 'queued' }).kind, 'cancel');
});

test("a task the daemon requeued after AgentDeck took the label off isn't cancelled for the missing label", () => {
  assert.deepEqual(issueMove(task(), issue({ labels: [] }), { reported: 'stopped' }), { kind: 'none' });
});

test('an issue closed as not planned cancels any task not done; a running task ignores a removed label', () => {
  assert.equal(
    issueMove(task({ status: 'running' }), issue({ open: false, closed_as: 'not_planned' }), { reported: 'running' }).kind,
    'cancel',
  );
  assert.equal(issueMove(task({ status: 'done' }), issue({ open: false, closed_as: 'not_planned' }), { reported: 'merged' }).kind, 'none');
  assert.equal(issueMove(task({ status: 'running' }), issue({ labels: [] }), { reported: 'running' }).kind, 'none');
});

test("the label put back on a blocked or failed task retries it; the note is what allowed people wrote since, not the daemon's own comments", () => {
  assert.deepEqual(issueMove(task({ status: 'blocked', question: { question: 'q', options: [] } }), issue(), { reported: 'question' }), {
    kind: 'retry',
  });
  assert.deepEqual(issueMove(task({ status: 'failed' }), issue(), { reported: 'stopped' }), { kind: 'retry' });
  assert.deepEqual(issueMove(task({ status: 'failed' }), issue({ labels: [] }), { reported: 'stopped' }), { kind: 'none' });
  const comments = [
    { author: 'tom', body: 'old', created_at: '2026-11-21T09:00:00Z' },
    { author: 'eve', body: 'spam', created_at: '2026-11-21T11:00:00Z' },
    { author: 'tom', body: signed('Task #12 needs an answer: which table?'), created_at: '2026-11-21T11:00:01Z' },
    { author: 'tom', body: 'Use the wallet table.', created_at: '2026-11-21T11:30:00Z' },
  ];
  assert.equal(issueNote(comments, '2026-11-21T10:00:00.000Z', ['tom']), 'Use the wallet table.');
  assert.match(issueNote([], null, ['tom']), /no new comment/);
});

test('the issue is told each change once: queued, running, a question, a stop, the PR, the merge', () => {
  const queued = dueIssueWrite(task({ prompt: 'Fill the pool.' }), { reported: null }, issue({ labels: [] }), true);
  assert.equal(queued?.to, 'queued');
  assert.deepEqual(queued?.add, ['ready-for-agent']);
  assert.match(queued?.comment ?? '', /Queued as AgentDeck task #12\.\n\nThe body should follow/);
  assert.equal(dueIssueWrite(task(), { reported: 'queued' }, issue(), true), null);
  const running = dueIssueWrite(task({ status: 'running' }), { reported: 'queued' }, issue(), true);
  assert.deepEqual([running?.add, running?.comment], [['agentdeck:running'], 'Task #12 started (attempt 1 of 2).']);
  const question = dueIssueWrite(
    task({ status: 'blocked', question: { question: 'Which table?', options: ['wallets', 'orders'] } }),
    { reported: 'running' },
    issue({ labels: ['ready-for-agent', 'agentdeck:running'] }),
    true,
  );
  assert.deepEqual([question?.add, question?.remove], [['needs-info'], ['ready-for-agent', 'agentdeck:running']]);
  assert.match(question?.comment ?? '', /> Which table\?\n\n- wallets\n- orders/);
  const failed = dueIssueWrite(task({ status: 'failed', stop_reason: 'tests failed' }), { reported: 'running' }, issue(), true);
  assert.match(failed?.comment ?? '', /Task #12 failed: tests failed/);
  const pr = dueIssueWrite(
    task({ status: 'done', pr: { state: 'open', url: 'https://x/pull/9' } }),
    { reported: 'running' },
    issue(),
    true,
  );
  assert.deepEqual([pr?.to, pr?.close], ['pr_open', false]);
  const merged = dueIssueWrite(
    task({ status: 'done', pr: { state: 'merged', url: 'https://x/pull/9' } }),
    { reported: 'pr_open' },
    issue(),
    true,
  );
  assert.deepEqual([merged?.to, merged?.close, merged?.comment], ['merged', true, 'Merged in https://x/pull/9.']);
  assert.equal(dueIssueWrite(task({ status: 'cancelled' }), { reported: 'queued' }, issue(), true)?.close, false);
  assert.equal(dueIssueWrite(task({ status: 'proposed' }), { reported: null }, issue(), true), null);
});

test('the write names only the labels the issue lacks or still has, and closes only an open issue', () => {
  const running = dueIssueWrite(task({ status: 'running' }), { reported: 'queued' }, issue({ labels: ['agentdeck:running'] }), true);
  assert.deepEqual([running?.add, running?.remove], [[], []]);
  const merged = { status: 'done', pr: { state: 'merged', url: 'u' } };
  assert.equal(dueIssueWrite(task(merged), { reported: 'pr_open' }, issue({ open: false }), true)?.close, false);
  assert.deepEqual(
    [isFinalReport('merged'), isFinalReport('cancelled'), isFinalReport('pr_open'), isFinalReport(null)],
    [true, true, false, false],
  );
});

test("a done task's issue waits for its pull request; in a repo that opens none, done is the end", () => {
  assert.equal(dueIssueWrite(task({ status: 'done', pr: null }), { reported: 'running' }, issue(), true), null);
  assert.equal(dueIssueWrite(task({ status: 'done', pr: null }), { reported: 'running' }, issue(), false)?.close, true);
});
