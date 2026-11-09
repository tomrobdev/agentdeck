// Protected edits: a worker writes files under .claude/ to .agentdeck/edits/, and the daemon commits them after the run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-protected-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('./open-db.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { applyProtectedEdits } = await import('../src/adapters/local/protected-edits.ts');
const { writePlanFile } = await import('../src/adapters/local/plan-file.ts');
const { EDITS_FOLDER, editPathFor, isProtectedPath, protectedEditTarget, protectedEditsMessage } =
  await import('../src/domain/repos/protected-edits.ts');
const { workerSystemPrompt } = await import('../src/domain/runs/prompt.ts');
const { parseLogLine } = await import('../src/domain/runs/translate/log.ts');

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function newRepo(name: string): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
/** Write `text` at `path` in `dir`'s edits folder, as a worker does. */
function edit(dir: string, path: string, text: string): void {
  const file = join(dir, EDITS_FOLDER, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test('protectedEditTarget takes paths under .claude/, with or without the dot, and refuses the rest', () => {
  assert.deepEqual(protectedEditTarget('.claude/skills/x/SKILL.md'), { target: '.claude/skills/x/SKILL.md' });
  assert.deepEqual(protectedEditTarget('claude/skills/x/SKILL.md'), { target: '.claude/skills/x/SKILL.md' });
  for (const path of ['../x', '.claude/../x', 'claude/skills/../../../x', '/etc/passwd', '/.claude/x', 'C:/x']) {
    assert.ok('refused' in protectedEditTarget(path), `${path} is refused`);
  }
  for (const path of ['src/x.ts', 'x', '.github/workflows/ci.yml', '.clauded/x', '']) {
    assert.ok('refused' in protectedEditTarget(path), `${path} is refused`);
  }
  for (const path of ['.claude/settings.json', 'claude/settings.local.json', '.claude/hooks/x.sh']) {
    assert.match((protectedEditTarget(path) as { refused: string }).refused, /never applied/);
  }
  assert.ok('refused' in protectedEditTarget('.claude//x'));
  assert.ok('refused' in protectedEditTarget('.claude/./x'));
  assert.ok('refused' in protectedEditTarget('.claude\\x'));

  assert.equal(isProtectedPath('.claude/skills/x/SKILL.md'), true);
  assert.equal(isProtectedPath('src/.claude.ts'), false);
  assert.equal(editPathFor('.claude/skills/x/SKILL.md'), '.agentdeck/edits/claude/skills/x/SKILL.md');
  assert.equal(protectedEditsMessage(['.claude/a', '.claude/b']), 'Apply protected edits: .claude/a, .claude/b');
});

test('the worker is told where to write protected edits, and to block only for settings and hooks', () => {
  const prompt = workerSystemPrompt('pnpm test');
  assert.match(prompt, /\.agentdeck\/edits\/claude\/skills\/x\/SKILL\.md for \.claude\/skills\/x\/SKILL\.md/);
  assert.match(prompt, /never applies \.claude\/settings\.json, \.claude\/settings\.local\.json, \.claude\/hooks\/: for those, block/);
});

test('applyProtectedEdits commits the edits under .claude/ and clears the folder', async () => {
  const dir = newRepo('apply');
  await writePlanFile(dir, null); // the ignored folder every run gets
  edit(dir, '.claude/skills/x/SKILL.md', '# x\n');
  edit(dir, 'claude/skills/y/SKILL.md', '# y\n');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'the edits folder is ignored');

  const out = await applyProtectedEdits(dir);
  assert.deepEqual(out, { applied: ['.claude/skills/x/SKILL.md', '.claude/skills/y/SKILL.md'], refused: [] });
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'Apply protected edits: .claude/skills/x/SKILL.md, .claude/skills/y/SKILL.md');
  assert.equal(git(dir, 'show', 'HEAD:.claude/skills/x/SKILL.md'), '# x');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.ok(!existsSync(join(dir, EDITS_FOLDER)));

  // An edit that changes nothing makes no commit; no edits folder at all is nothing to do.
  edit(dir, '.claude/skills/x/SKILL.md', '# x\n');
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.deepEqual(await applyProtectedEdits(dir), { applied: [], refused: [] });
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(await applyProtectedEdits(dir), { applied: [], refused: [] });
});

test('an edit outside .claude/, a symlink, or a target that leads out of the worktree is refused and nothing is written', async () => {
  const dir = newRepo('refuse');
  await writePlanFile(dir, null);
  const secret = join(home, 'secret.txt');
  writeFileSync(secret, 'secret\n');
  edit(dir, 'src/outside.ts', 'export const x = 1;\n');
  edit(dir, '.claude/settings.json', '{"hooks":{}}\n');
  mkdirSync(join(dir, EDITS_FOLDER, '.claude/skills'), { recursive: true });
  symlinkSync(secret, join(dir, EDITS_FOLDER, '.claude/skills/link.md'));
  // A .claude folder committed as a symlink to somewhere else in the file system.
  const elsewhere = join(home, 'elsewhere');
  mkdirSync(elsewhere);
  const other = newRepo('refuse-link');
  symlinkSync(elsewhere, join(other, '.claude'));
  await writePlanFile(other, null);
  edit(other, '.claude/skills/x/SKILL.md', '# x\n');
  const head = git(dir, 'rev-parse', 'HEAD');

  const out = await applyProtectedEdits(dir);
  assert.deepEqual(out.applied, []);
  assert.deepEqual(out.refused.map((r) => r.path).sort(), ['.claude/settings.json', '.claude/skills/link.md', 'src/outside.ts']);
  assert.ok(!existsSync(join(dir, 'src/outside.ts')));
  assert.ok(!existsSync(join(dir, '.claude')));
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.ok(!existsSync(join(dir, EDITS_FOLDER)));

  const linked = await applyProtectedEdits(other);
  assert.deepEqual(linked, {
    applied: [],
    refused: [{ path: '.claude/skills/x/SKILL.md', reason: 'the target folder resolves outside the worktree' }],
  });
  assert.ok(!existsSync(join(elsewhere, 'skills')));
});

test('a run whose worker wrote protected edits ends with them committed on the branch and the edits folder empty', async () => {
  const db = openDb(join(home, 'test.db'));
  after(() => db.close());
  const dir = newRepo('demo');
  const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main', test_cmd: 'test -f .claude/skills/x/SKILL.md' });
  const t = db.addTask({ repo_id: repo.id, title: 'skill', prompt: 'FAKE_PROTECTED_EDIT write a skill' });
  await new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();

  const task = db.getTask(t.id)!;
  assert.equal(task.status, 'done', 'the tests ran after the edits were applied');
  const files = git(dir, 'ls-tree', '-r', '--name-only', task.checkout!.branch!).split('\n');
  assert.ok(files.includes('.claude/skills/x/SKILL.md'));
  assert.ok(files.includes('.claude/skills/y/SKILL.md'));
  assert.ok(!files.includes('src/outside.ts'));
  assert.ok(!files.some((f) => f.startsWith('.agentdeck')));
  assert.equal(git(dir, 'show', `${task.checkout?.branch}:.claude/skills/x/SKILL.md`), '# x\nnew skill');
  assert.ok(!existsSync(join(task.checkout!.worktree!, EDITS_FOLDER)));
  assert.ok(!existsSync(join(task.checkout!.worktree!, 'src/outside.ts')));

  const run = db.runsForTask(t.id)[0];
  const event = readFileSync(run.log_path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((e) => e.type === 'agentdeck_protected_edits');
  assert.deepEqual(event.applied, ['.claude/skills/x/SKILL.md', '.claude/skills/y/SKILL.md']);
  assert.deepEqual(event.refused, [{ path: 'src/outside.ts', reason: 'not under .claude/' }]);
  assert.deepEqual(
    parseLogLine(JSON.stringify(event)).map((e) => [e.kind, (e as { text: string }).text]),
    [
      ['text', 'Applied protected edits: .claude/skills/x/SKILL.md, .claude/skills/y/SKILL.md'],
      ['error', 'Refused protected edit src/outside.ts: not under .claude/'],
    ],
  );
});
