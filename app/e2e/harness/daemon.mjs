#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    port: { type: 'string', default: '4391' },
    origin: { type: 'string', default: 'http://127.0.0.1:1430' },
    keep: { type: 'boolean', default: false },
  },
});
const ROOT = resolve(import.meta.dirname, '../../..');
const CLI = join(ROOT, 'daemon/src/cli.ts');
const FAKE_GH = join(ROOT, 'daemon/scripts/fake-gh.mjs');
const CLAUDE = join(import.meta.dirname, 'claude.mjs');
const PLAN = join(import.meta.dirname, 'plan.html');
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const log = (line) => console.log(`[ui-daemon] ${line}`);

const home = mkdtempSync(join(tmpdir(), 'agentdeck-ui-'));
const bin = join(home, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE_GH)} "$@"\n`, { mode: 0o755 });
chmodSync(CLAUDE, 0o755);
const env = {
  ...process.env,
  AGENTDECK_HOME: home,
  AGENTDECK_CLAUDE_BIN: CLAUDE,
  AGENTDECK_NO_NOTIFY: '1',
  AGENTDECK_PORT: opts.port,
  AGENTDECK_ORIGINS: opts.origin,
  FAKE_GH_DIR: home,
  FAKE_GH_FROM_GIT: '1',
  GIT_AUTHOR_NAME: 'Demo',
  GIT_AUTHOR_EMAIL: 'demo@example.com',
  GIT_COMMITTER_NAME: 'Demo',
  GIT_COMMITTER_EMAIL: 'demo@example.com',
  PATH: `${bin}:${process.env.PATH}`,
};
const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: 'ignore' });

function makeRepo() {
  const origin = join(home, 'origin.git');
  git(home, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(home, 'demo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n\nA small queue, used by the dashboard tests.\n');
  writeFileSync(
    join(repo, 'src/greet.ts'),
    "/** A greeting for one person. */\nexport function greet(name: string): string {\n  return 'Hello, ' + name + '!';\n}\n",
  );
  writeFileSync(
    join(repo, 'src/queue.ts'),
    [
      '// A first-in, first-out queue of strings.',
      '// TODO: pick a store',
      'const items: string[] = [];',
      '',
      'export function push(item: string): void {',
      '  items.push(item);',
      '}',
      '',
      'export function pop(): string | undefined {',
      '  return items.shift();',
      '}',
      '',
    ].join('\n'),
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'A queue and a greeting');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  return repo;
}

function prView(number, view) {
  writeFileSync(join(home, `pr-view-${number}.json`), JSON.stringify(view));
}
const check = (status, conclusion) => ({
  __typename: 'CheckRun',
  name: 'check',
  workflowName: 'check',
  status,
  conclusion,
  startedAt: '2026-01-05T10:01:00Z',
  completedAt: status === 'COMPLETED' ? '2026-01-05T10:04:00Z' : '0001-01-01T00:00:00Z',
  detailsUrl: 'https://github.com/demo/demo/actions/runs/1/job/1',
});

function seed() {
  const repo = makeRepo();
  cli('repo', 'add', repo, '--name', 'demo', '--test', 'true', '--setup', '', '--tools', 'Read,Edit,Write,Glob,Grep,Bash(true)');
  cli('resume');
  for (const [key, value] of [
    ['pr_mode', 'ready'],
    ['auto_merge', 'on'],
    ['auto_unblock', 'on'],
    ['code_comment_max_lines', '0'],
    ['code_comment_max_percent', '0'],
  ])
    cli('repo', 'set', 'demo', key, value);
  for (const [key, value] of [
    ['max_concurrent', '1'],
    ['reload_on_change', 'off'],
    ['planner_enabled', 'off'],
    ['notify_desktop', 'off'],
  ])
    cli('set', key, value);
  cli('add', 'UI_QUEUE: push() returns the new length', '--repo', 'demo', '--title', 'Say how long the queue is');
  cli('add', 'UI_GREET: greet everyone when no name is given', '--repo', 'demo', '--title', 'Greet everyone', '--plan', PLAN);
  cli('add', 'UI_QUEUE: pop() says when the queue is empty', '--repo', 'demo', '--title', 'Document pop()');
  cli('add', 'UI_BLOCKED: keep the queue on disk', '--repo', 'demo', '--title', 'Keep the queue on disk');
  cli('auto-merge', '3', 'off');
  prView(1, { statusCheckRollup: [check('COMPLETED', 'SUCCESS')] });
  prView(2, { statusCheckRollup: [check('IN_PROGRESS', '')] });
  prView(3, { statusCheckRollup: [check('COMPLETED', 'SUCCESS')], labels: [], mergeStateStatus: 'CLEAN' });
  if (process.env.UI_DAEMON_VERBOSE) log(cli('status'));
  log('working the queue once');
  const worked = cli('run-once');
  if (process.env.UI_DAEMON_VERBOSE) log(worked);
  cli('merge', '1', '--yes');
  cli('repo', 'set', 'demo', 'auto_unblock', 'off');
  cli('add', 'UI_GREET: greet in French too', '--repo', 'demo', '--title', 'Greet in French', '--propose');
  cli('add', 'UI_RUNNING: write a usage section', '--repo', 'demo', '--title', 'Write the usage section');
  log(cli('ls').trim());
}

let daemon = null;
function stop(code) {
  if (daemon && daemon.exitCode === null) daemon.kill('SIGTERM');
  if (opts.keep) log(`kept ${home}`);
  else rmSync(home, { recursive: true, force: true });
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => daemon?.kill('SIGTERM') ?? stop(0));

try {
  seed();
} catch (err) {
  console.error(`[ui-daemon] the seed failed: ${err.stderr ?? ''}${err.stdout ?? ''}${err.message}`);
  stop(1);
}
log(`daemon on http://127.0.0.1:${opts.port}, home ${home}`);
daemon = spawn(process.execPath, [CLI, 'daemon'], { env, stdio: 'inherit' });
daemon.on('exit', (code) => stop(code ?? 0));
