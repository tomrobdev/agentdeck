// pnpm check:task's path rules (daemon/scripts/lib/check-task.ts): which extra checks a branch's changed paths call for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ciJobs, extraChecks, reasonLine, skipLine, EXTRA_CHECKS } from '#scripts/lib/check-task.ts';

const names = (paths: string[]) => extraChecks(paths).map((c) => c.name);

test('a branch changing only docs runs check:fast alone', () => {
  assert.deepEqual(names(['docs/architecture.md', 'docs/reference/progress.md', 'CLAUDE.md']), []);
  assert.deepEqual(names([]), []);
});

test('a branch changing daemon/src/db/ runs the crash test', () => {
  assert.deepEqual(names(['daemon/src/db/tasks.ts']), ['crash test']);
});

test('each crash-test path calls for it', () => {
  for (const path of [
    'daemon/src/application/runs/worker.ts',
    'daemon/src/application/scheduler/scheduler.ts',
    'daemon/src/adapters/process/processes.ts',
    'daemon/src/adapters/claude/claude.ts',
    'daemon/src/db/schema.ts',
    'daemon/scripts/crash-test.mjs',
  ]) {
    assert.deepEqual(names([path]), ['crash test'], path);
  }
});

test('paths beside the crash-test ones do not call for it', () => {
  for (const path of [
    'daemon/src/application/landing/merge.ts',
    'daemon/src/application/runs.ts',
    'daemon/src/adapters/claude-usage.ts',
    'daemon/src/adapters/git.ts',
    'daemon/src/domain/runs/run.ts',
    'daemon/test/db.test.ts',
  ]) {
    assert.deepEqual(names([path]), [], path);
  }
});

test('a branch changing app/src-tauri/ runs check:rust', () => {
  assert.deepEqual(names(['app/src-tauri/src/main.rs']), ['check:rust']);
  assert.deepEqual(names(['app/src-tauri/tauri.conf.json']), ['check:rust']);
});

test("a branch changing the dashboard, its end-to-end tests or the API's routes and contract runs test:ui, and the Tauri shell's doesn't", () => {
  for (const path of [
    'app/src/App.vue',
    'app/src/lib/work/files/diff.ts',
    'app/e2e/look/queue.spec.ts',
    'app/playwright.config.ts',
    'daemon/src/api/contract/files.ts',
    'daemon/src/api/routes/work/tasks.ts',
  ]) {
    assert.deepEqual(names([path]), ['test:ui'], path);
  }
  for (const path of [
    'app/src-tauri/src/main.rs',
    'app/package.json',
    'app/vite.config.ts',
    'daemon/src/api/http.ts',
    'daemon/src/domain/work/task/task.ts',
  ]) {
    assert.ok(!names([path]).includes('test:ui'), path);
  }
});

test("CI runs a pull request's extra jobs as check:task would, and every job when it cannot tell or the rules change", () => {
  assert.deepEqual(ciJobs(['docs/architecture.md']), { crash: false, rust: false, ui: false });
  assert.deepEqual(ciJobs(['daemon/src/db/schema.ts']), { crash: true, rust: false, ui: false });
  assert.deepEqual(ciJobs(['app/src/App.vue']), { crash: false, rust: false, ui: true });
  assert.deepEqual(ciJobs(null), { crash: true, rust: true, ui: true });
  for (const path of ['.github/workflows/check.yml', 'scripts/check-task.mjs', 'daemon/scripts/lib/check-task.ts'])
    assert.deepEqual(ciJobs([path]), { crash: true, rust: true, ui: true }, path);
});

test('test:ui runs pnpm test:ui, the command CI runs', () => {
  assert.deepEqual(EXTRA_CHECKS.find((c) => c.name === 'test:ui')?.command, ['pnpm', 'test:ui']);
});

test('a branch changing both runs both, the crash test first, each with the paths that call for it', () => {
  const chosen = extraChecks(['app/src-tauri/Cargo.toml', 'daemon/src/db/tasks.ts', 'docs/x.md', 'daemon/src/db/tasks.ts']);
  assert.deepEqual(
    chosen.map((c) => [c.name, c.because]),
    [
      ['crash test', ['daemon/src/db/tasks.ts']],
      ['check:rust', ['app/src-tauri/Cargo.toml']],
    ],
  );
});

test('the crash test runs 5 times', () => {
  assert.deepEqual(EXTRA_CHECKS[0].command, ['node', 'daemon/scripts/crash-test.mjs', '6']);
});

test('the reason line names the paths, and how many more', () => {
  const [crash] = extraChecks(['daemon/src/db/a.ts', 'daemon/src/db/b.ts', 'daemon/src/db/c.ts', 'daemon/src/db/d.ts']);
  assert.equal(reasonLine(crash), 'crash test: the branch changes daemon/src/db/a.ts, daemon/src/db/b.ts, daemon/src/db/c.ts and 1 more');
  assert.equal(
    reasonLine(crash, 4),
    'crash test: the branch changes daemon/src/db/a.ts, daemon/src/db/b.ts, daemon/src/db/c.ts, daemon/src/db/d.ts',
  );
  assert.match(skipLine(EXTRA_CHECKS[1]), /^check:rust: skipped, the branch changes none of app\/src-tauri\/$/);
});
