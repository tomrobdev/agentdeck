// How the CLI words tasks, checks, auto-merge, runs, findings and doctor reports, and how it reads ids.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '../../src/domain/shared/index.ts';
import {
  fmtAutoMerge,
  fmtChecks,
  fmtLink,
  fmtPrompt,
  fmtProposalCheck,
  fmtRunSummary,
  fmtTask,
  fmtVerifyFindings,
  idsText,
  printDoctor,
  printHealth,
  relTime,
  taskId,
  taskIds,
} from '../../src/cli/format.ts';

const capture = (fn: () => void): string[] => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = log;
  }
  return lines;
};

const task = (over: Record<string, unknown>) =>
  ({ id: 7, status: 'queued', priority: 2, title: 'Title', stop_reason: null, pr: null, ...over }) as never;

test('ids are read as positive whole numbers or lists of them, and shown with a #', () => {
  assert.equal(taskId('12'), 12);
  assert.deepEqual(taskIds('1,2', '--after'), [1, 2]);
  assert.equal(idsText([asTaskId(1), asTaskId(2)]), '#1, #2');
});

test('a task line shows its status icon, priority, repo and title, with the reason, wait, PR, auto-merge, links and unblocks after it', () => {
  assert.match(fmtTask(task({}), 'repo'), /^· #7 {4}queued {4}p2 {2}repo {11}Title$/);
  assert.match(fmtTask(task({ status: 'blocked', stop_reason: 'why' }), 'r'), /^! .*Title {2}— why$/);
  assert.match(fmtTask(task({ waiting: { on: [1], stuck: null } }), 'r'), /waiting on #1$/);
  assert.match(fmtTask(task({ waiting: { on: [1], stuck: '#1 failed' } }), 'r'), /can't start: #1 failed \(retry #1 or cancel this task\)/);
  assert.match(
    fmtTask(task({ pr: { url: 'u', state: 'open' }, auto_merge_view: { state: 'on', label: 'auto-merge on' } }), 'r'),
    /PR open: u {2}auto-merge on/,
  );
  assert.doesNotMatch(fmtTask(task({ auto_merge_view: { state: 'off', label: 'x' } }), 'r'), /x$/);
  const linked = fmtTask(
    task({
      links: [
        { on: 1, kind: 'after', state: 'met' },
        { on: 2, kind: 'builds_on', state: 'waiting' },
      ],
      unblocks: [asTaskId(9)],
    }),
    'r',
  );
  assert.match(linked, /after #1 \(met\)/);
  assert.match(linked, /builds on #2 \(waiting\)/);
  assert.match(linked, /unblocks #9$/);
  assert.equal(fmtLink({ on: asTaskId(3), kind: 'after', state: 'unlanded' }), 'after #3 (not landed yet)');
});

test('a proposal check lists its line, the changed files, the overlaps and the notes', () => {
  const lines = fmtProposalCheck({
    staleness: {
      ref: 'main',
      base: 'a',
      commits: 2,
      changed: [{ path: 'a.ts', commits: [{ sha: '1234567890', subject: 'fix', at: 'x' }] }],
    },
    notes: ['n1'],
    overlaps: [{ id: asTaskId(4), title: 'T', status: 'queued', paths: ['a.ts'], linked: true }],
  });
  assert.match(lines[0], /^check {4}written 2 commits ago/);
  assert.equal(lines[1], '         changed a.ts: 1234567 fix');
  assert.equal(lines[2], '         #4 T (linked) touches a.ts');
  assert.equal(lines[3], 'note     n1');
  assert.deepEqual(fmtProposalCheck({ staleness: null, notes: [], overlaps: [] }), []);
});

test('verify findings list the verdict, the claim with its place, the evidence and the fix', () => {
  const lines = fmtVerifyFindings([
    { claim: 'c', verdict: 'false', path: 'a.ts', line: 3, evidence: 'ev', fix: 'fx' },
    { claim: 'd', verdict: 'true', path: null, line: null, evidence: '', fix: '' },
  ] as never);
  assert.equal(lines.length, 5);
  assert.match(lines[1], /^false {2}c \(a\.ts:3\)$/);
  assert.equal(lines[2], '       ev');
  assert.equal(lines[3], '       fix: fx');
  assert.match(lines[4], /^true {3}d$/);
});

test('a run summary gives the verdict, the time with the top tools, and the last lines of a failure', () => {
  const lines = fmtRunSummary({
    verdict: 'ok',
    minutes: 5,
    test_runs: 2,
    test_minutes: 1,
    tools: [{ name: 'Edit', count: 3 }],
    excerpt: 'a\nb',
  } as never);
  assert.deepEqual(lines, ['ok', '5 min, 1 in tests · Edit 3', 'last failure:', '  │ a', '  │ b']);
  assert.deepEqual(fmtRunSummary({ verdict: 'ok', minutes: 1, test_runs: 0, tools: [], excerpt: null } as never), ['ok', '1 min']);
});

test('auto-merge says its state, the reasons, when it was checked and the limits', () => {
  const view = {
    label: 'on',
    source: 'repo',
    state: 'on',
    reasons: ['r1'],
    checked_at: '2026-01-01',
    limits: { max_lines: 1000, skip: [], tests: 'tests must pass', review: 'a review' },
  } as never;
  const lines = fmtAutoMerge(view);
  assert.equal(lines[0], "auto-merge on (the repo's setting)");
  assert.equal(lines[1], '           - r1');
  assert.equal(lines[2], '           checked 2026-01-01 UTC');
  assert.equal(lines[3], '           limits: 1,000 lines, not touching nothing; tests must pass; a review');
  assert.equal(fmtAutoMerge({ label: 'off', source: 'task', state: 'off', reasons: [], checked_at: null } as never).length, 1);
});

test('checks say none failing, or which fail with the fix command and their details', () => {
  assert.equal(fmtChecks({ total: 3, failing: 0, pending: 1 } as never), 'checks   3 on the PR, none failing, 1 running');
  const failing = fmtChecks(
    { total: 3, failing: 1, pending: 0, failing_names: ['ci'], failing_lines: ['ci', 'ci: step x'] } as never,
    asTaskId(5),
  );
  assert.match(failing, /^checks {3}1 of 3 failing: ci {2}\(agentdeck fix-checks 5\)\n {9}- ci: step x$/);
  assert.doesNotMatch(fmtChecks({ total: 1, failing: 1, pending: 0, failing_names: ['x'], failing_lines: ['x'] } as never), /fix-checks/);
});

test('a doctor report and a health report print a line per check, the fix, and a closing line', () => {
  const doctor = capture(() =>
    printDoctor({
      ok: false,
      repo: 'r',
      paused_reason: 'bad',
      checks: [
        { ok: true, name: 'git', reason: 'fine' },
        { ok: false, name: 'tests', reason: 'red' },
      ],
    } as never),
  );
  assert.match(doctor[0], /^✓ git {12}fine$/);
  assert.match(doctor[1], /^✗ tests {10}red$/);
  assert.match(doctor[2], /^r: PAUSED \(bad\); fix the failed checks and run `agentdeck repo doctor r`$/);
  assert.deepEqual(
    capture(() => printDoctor({ ok: true, repo: 'r', checks: [] } as never)),
    ['r: ready'],
  );
  const health = capture(() =>
    printHealth([
      { ok: true, warning: true, name: 'a', reason: 'warn' },
      { ok: false, name: 'b', reason: 'bad', fix: 'do x' },
    ] as never),
  );
  assert.match(health[0], /^! a {17}warn$/);
  assert.equal(health[2], '  → do x');
  assert.equal(health[3], '1 of 2 checks failed, 1 warning');
  assert.deepEqual(capture(() => printHealth([{ ok: true, name: 'a', reason: 'x' }] as never)).at(-1), 'the daemon is healthy');
});

test('relTime says now for the past, minutes under 90, and hours after; fmtPrompt says lines, resume and note', () => {
  const now = Date.now() / 1000;
  assert.equal(relTime(now - 10), 'now');
  assert.equal(relTime(now + 30 * 60), '30m');
  assert.equal(relTime(now + 180 * 60), '3.0h');
  assert.equal(fmtPrompt({ lines: 1, resume: false, note: null }), '📝 prompt: 1 line');
  assert.equal(fmtPrompt({ lines: 4, resume: true, note: 'a\nb' }), '📝 resumed, prompt: 4 lines, note: a b');
});
