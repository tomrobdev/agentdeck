import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-staleness-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#test/fixtures/open-db.ts');
const { addTask, proposalCheck } = await import('#application/actions.ts');
const { parseBaseLog, proposalCheckLine, staleness } = await import('#domain/work/task/proposal-check.ts');
const { sqliteMs } = await import('#domain/shared/time.ts');
const { blockedTask } = await import('#test/fixtures/fixtures.ts');

const commit = (sha: string, paths: string[]) => ({ sha, subject: `change ${sha}`, at: '2026-11-01 10:00:00', paths });

test('the commits since the add, and the named paths they changed, in the order named', () => {
  const rows: { name: string; named: string[]; commits: ReturnType<typeof commit>[]; want: { commits: number; changed: string[] } }[] = [
    { name: 'fresh: nothing since', named: ['src/a.ts'], commits: [], want: { commits: 0, changed: [] } },
    {
      name: 'moved, but not the named files',
      named: ['src/a.ts'],
      commits: [commit('c1', ['src/b.ts'])],
      want: { commits: 1, changed: [] },
    },
    {
      name: 'moved: a named file and a named folder changed',
      named: ['src/a.ts', 'docs/', 'src/untouched.ts'],
      commits: [commit('c2', ['docs/x.md']), commit('c1', ['src/a.ts', 'src/b.ts'])],
      want: { commits: 2, changed: ['src/a.ts', 'docs/'] },
    },
    {
      name: 'a file with a longer name is not the named one',
      named: ['src/a.ts'],
      commits: [commit('c1', ['src/a.tsx', 'lib/src/a.ts'])],
      want: { commits: 1, changed: [] },
    },
  ];
  for (const r of rows) {
    const got = staleness(r.named, r.commits);
    assert.deepEqual({ commits: got.commits, changed: got.changed.map((c) => c.path) }, r.want, r.name);
  }
  const both = staleness(['src/a.ts'], [commit('c2', ['src/a.ts']), commit('c1', ['src/a.ts'])]);
  assert.deepEqual(
    both.changed[0].commits.map((c) => c.sha),
    ['c2', 'c1'],
    'each changed path lists the commits that changed it, newest first',
  );
});

test('the line says how far the base moved and how many named files changed; nothing for a fresh one', () => {
  const s = (commits: number, changed: number) => ({
    ref: 'main',
    base: 'abc',
    commits,
    changed: Array.from({ length: changed }, (_, i) => ({ path: `f${i}`, commits: [] })),
  });
  assert.equal(proposalCheckLine({ staleness: s(41, 3), notes: [], overlaps: [] }), 'written 41 commits ago · 3 named files changed');
  assert.equal(proposalCheckLine({ staleness: s(1, 0), notes: [], overlaps: [] }), 'written 1 commit ago');
  assert.equal(proposalCheckLine({ staleness: s(0, 0), notes: [], overlaps: [] }), null);
  assert.equal(proposalCheckLine({ staleness: null, notes: ['x'], overlaps: [] }), null);
});

test('git log -z --name-only output parses into commits with their paths, dates as UTC', () => {
  const out =
    '\x1eaaa\x1fsecond\x1f2026-11-01T12:00:00+02:00\0\ndocs/x.md\0src/a.ts\0\x1ebbb\x1ffirst\x1f2026-10-31T09:00:00Z\0\nsrc/b.ts\0';
  assert.deepEqual(parseBaseLog(out), [
    { sha: 'aaa', subject: 'second', at: '2026-11-01 10:00:00', paths: ['docs/x.md', 'src/a.ts'] },
    { sha: 'bbb', subject: 'first', at: '2026-10-31 09:00:00', paths: ['src/b.ts'] },
  ]);
});

const git = (cwd: string, env: Record<string, string>, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, ...env },
  }).toString();

function commitAt(path: string, ms: number, message: string) {
  const local = new Date(ms - 8 * 3600_000).toISOString().slice(0, 19);
  const date = `${local}-08:00`;
  git(path, {}, 'add', '-A');
  git(path, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, 'commit', '-q', '-m', message);
}

test('a commit after the add that changes a named file counts; created_at is read as UTC', async () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Etc/GMT+8';
  try {
    const path = mkdtempSync(join(tmpdir(), 'agentdeck-staleness-repo-'));
    git(path, {}, 'init', '-q', '-b', 'main');
    mkdirSync(join(path, 'src'));
    writeFileSync(join(path, 'src/a.ts'), 'a');
    writeFileSync(join(path, 'src/b.ts'), 'b');
    commitAt(path, Date.parse('2020-01-01T00:00:00Z'), 'init');
    const db = openDb(':memory:');
    const repo = db.addRepo({ name: 'demo', path, base_branch: 'main' });
    const t = await addTask(db, { repo: 'demo', prompt: 'Change `src/a.ts`, and read src/b.ts.', propose: true });

    const fresh = await proposalCheck(db, t.id);
    assert.equal(fresh.staleness?.commits, 0, 'nothing on the base since the add');
    assert.deepEqual(fresh.staleness?.changed, []);

    const added = sqliteMs(t.created_at);
    writeFileSync(join(path, 'src/a.ts'), 'a2');
    commitAt(path, added + 3600_000, 'change a');
    writeFileSync(join(path, 'README.md'), 'r');
    commitAt(path, added + 7200_000, 'readme');

    const check = await proposalCheck(db, t.id);
    assert.equal(check.staleness?.ref, 'main');
    assert.equal(check.staleness?.commits, 2);
    assert.deepEqual(
      check.staleness?.changed.map((c) => [c.path, c.commits.map((x) => x.subject)]),
      [['src/a.ts', ['change a']]],
    );
    assert.equal(proposalCheckLine(check), 'written 2 commits ago · 1 named file changed');
    assert.deepEqual(check.notes, []);

    const blocked = blockedTask(db, repo, { prompt: 'Change `src/a.ts`' });
    assert.deepEqual(await proposalCheck(db, blocked.id), { staleness: null, notes: [], overlaps: [] }, 'past approval: an empty check');
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('a repo git cannot read has an empty check, not an error', async () => {
  const db = openDb(':memory:');
  const path = mkdtempSync(join(tmpdir(), 'agentdeck-staleness-nogit-'));
  db.addRepo({ name: 'nogit', path, base_branch: 'main' });
  const t = await addTask(db, { repo: 'nogit', prompt: 'Change `src/a.ts`', propose: true });
  assert.deepEqual(await proposalCheck(db, t.id), { staleness: null, notes: [], overlaps: [] });
});

test('agentdeck show prints the same line for a proposal, with the files and the commits that changed them', async () => {
  const path = mkdtempSync(join(tmpdir(), 'agentdeck-staleness-cli-'));
  git(path, {}, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'notes.md'), 'n');
  commitAt(path, Date.parse('2020-01-01T00:00:00Z'), 'init');
  const db = openDb(join(home, 'agentdeck.db'));
  db.addRepo({ name: 'cli-demo', path, base_branch: 'main' });
  const t = await addTask(db, { repo: 'cli-demo', prompt: 'Follow `notes.md`.', propose: true });
  writeFileSync(join(path, 'notes.md'), 'n2');
  commitAt(path, sqliteMs(t.created_at) + 3600_000, 'rewrite the notes');
  const line = proposalCheckLine(await proposalCheck(db, t.id));
  db.close();

  const shown = spawnSync(process.execPath, [join(import.meta.dirname, '../../src/cli.ts'), 'show', String(t.id)], {
    encoding: 'utf8',
    env: { ...process.env, AGENTDECK_HOME: home, AGENTDECK_TASK_ID: '', AGENTDECK_PLANNER: '' },
  });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(line, 'written 1 commit ago · 1 named file changed');
  assert.ok(shown.stdout.includes(`check    ${line}`), shown.stdout);
  assert.match(shown.stdout, /changed notes\.md: [0-9a-f]{7} rewrite the notes/);
});
