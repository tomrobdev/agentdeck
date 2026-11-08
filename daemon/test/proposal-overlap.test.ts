// Which open tasks touch the same files as a proposal: the paths each names, and a branch's changed files, meeting.
// The rule on plain values, then the use case on real git.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-overlap-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('./open-db.ts');
const { addTask, proposalCheck } = await import('../src/application/actions.ts');
const { mayOverlap, overlaps, proposalCheckLine } = await import('../src/domain/work/proposal-check.ts');
const { asTaskId } = await import('../src/domain/shared/id.ts');
const { doneTask, runningTask } = await import('./fixtures.ts');

const candidate = (id: number, paths: string[], linked = false) => ({
  id: asTaskId(id),
  title: `t${id}`,
  status: 'proposed' as const,
  paths,
  linked,
});

test('[overlap] paths meet when they are the same file, or a file in a named folder; the file is what they share', () => {
  const got = overlaps(
    ['src/a.ts', 'docs/'],
    [
      candidate(1, ['src/a.ts']),
      candidate(2, ['docs/plan.md', 'src/b.ts']),
      candidate(3, ['src/b.ts', 'src/a.tsx']),
      candidate(4, ['docs/']),
    ],
  );
  assert.deepEqual(
    got.map((o) => [o.id, o.paths]),
    [
      [1, ['src/a.ts']],
      [2, ['docs/plan.md']],
      [4, ['docs/']],
    ],
  );
});

test('[overlap] open tasks count: proposed, queued, running, and done with an open PR', () => {
  const t = (status: 'proposed' | 'queued' | 'running' | 'done' | 'blocked' | 'cancelled', pr: 'open' | 'merged' | null = null) => ({
    status,
    pr: pr ? { state: pr } : null,
  });
  assert.deepEqual(
    [t('proposed'), t('queued'), t('running'), t('done', 'open'), t('done', 'merged'), t('done'), t('blocked'), t('cancelled')].map(
      mayOverlap,
    ),
    [true, true, true, true, false, false, false, false],
  );
});

test('[overlap] the line names the tasks not linked yet', () => {
  const check = (linked: boolean) => ({
    staleness: null,
    notes: [],
    overlaps: [{ id: asTaskId(247), title: 'x', status: 'queued' as const, paths: ['a.ts'], linked }],
  });
  assert.equal(proposalCheckLine(check(false)), 'touches the same files as #247');
  assert.equal(proposalCheckLine(check(true)), null);
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

function gitRepo(): string {
  const path = mkdtempSync(join(tmpdir(), 'agentdeck-overlap-repo-'));
  git(path, 'init', '-q', '-b', 'main');
  mkdirSync(join(path, 'src'));
  for (const f of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(path, 'src', f), f);
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'init');
  return path;
}

test('[overlap] named against named, named against changed, a link marked, another repo ignored', async () => {
  const db = openDb(':memory:');
  const path = gitRepo();
  const repo = db.addRepo({ name: 'demo', path, base_branch: 'main' });
  const other = db.addRepo({ name: 'other', path: gitRepo(), base_branch: 'main' });

  const p = await addTask(db, { repo: 'demo', prompt: 'Change `src/a.ts` and `src/b.ts`.', status: 'proposed' });
  // Two proposals approved together warn about each other.
  const q = await addTask(db, { repo: 'demo', prompt: 'Rename things in `src/a.ts`.', status: 'proposed' });
  // A running task whose prompt names nothing, but whose branch changed src/b.ts.
  const branch = 'agentdeck/changes-b';
  git(path, 'checkout', '-q', '-b', branch);
  writeFileSync(join(path, 'src/b.ts'), 'b2');
  git(path, 'commit', '-qam', 'change b');
  git(path, 'checkout', '-q', 'main');
  const r = runningTask(db, repo, { prompt: 'Tidy up.', branch });
  // Linked already: a done task with an open PR, naming src/a.ts.
  const linked = doneTask(db, repo, { prompt: 'Fix `src/a.ts`.', pr: 'open' });
  db.addLink({ task_id: p.id, on: linked.id, kind: 'after' });
  // Ignored: another repo's proposal on the same path, and this repo's merged task.
  await addTask(db, { repo: other.name, prompt: 'Change `src/a.ts`.', status: 'proposed' });
  doneTask(db, repo, { prompt: 'Old `src/a.ts` work.', pr: 'merged' });

  const check = await proposalCheck(db, p.id);
  assert.deepEqual(
    check.overlaps.map((o) => ({ id: o.id, paths: o.paths, linked: o.linked })),
    [
      { id: q.id, paths: ['src/a.ts'], linked: false },
      { id: r.id, paths: ['src/b.ts'], linked: false },
      { id: linked.id, paths: ['src/a.ts'], linked: true },
    ],
    'oldest first',
  );
  assert.equal(proposalCheckLine(check), `touches the same files as #${q.id}, #${r.id}`);

  const back = await proposalCheck(db, q.id);
  assert.deepEqual(
    back.overlaps.map((o) => o.id),
    [p.id, linked.id],
    'the other proposal sees this one too',
  );
});
