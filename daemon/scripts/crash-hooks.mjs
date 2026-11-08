#!/usr/bin/env node
// The crash test's stand-ins for a repo's commands and git hooks: `node crash-hooks.mjs <what> <home>`.
//   setup       the repo's setup command. The first task to run it (and only that one) gets a sync to do: it commits
//               shared.txt on the task's branch and pushes a commit to origin's base, which conflicts with it when
//               <home>/sync-mode says `conflict` (a resolve run) and merges cleanly when it says `clean`.
//   test        the repo's test command: passes.
//   merge-hook  the repo's pre-merge-commit hook, which git runs inside a clean merge, before the merge commit.
// While <home>/hang-<phase> exists (`tests` for `test`, `sync` for `merge-hook`), the command appends its pid to
// <home>/hangs.jsonl and waits, so the test can kill the daemon there; once the file is gone it fails, as if killed.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [what, home] = process.argv.slice(2);

async function hangWhile(phase) {
  const file = join(home, `hang-${phase}`);
  if (!existsSync(file)) return;
  appendFileSync(join(home, 'hangs.jsonl'), JSON.stringify({ phase, pid: process.pid, cwd: process.cwd(), t: Date.now() }) + '\n');
  for (;;) {
    await new Promise((r) => setTimeout(r, 50));
    if (!existsSync(file)) process.exit(1);
  }
}

function setup() {
  const mode = existsSync(join(home, 'sync-mode')) ? readFileSync(join(home, 'sync-mode'), 'utf8').trim() : '';
  if (!mode) return;
  try {
    writeFileSync(join(home, 'base-moved'), process.cwd(), { flag: 'wx' });
  } catch {
    return; // another task has the sync, or this one's setup ran already
  }
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });
  writeFileSync('shared.txt', 'task side\n');
  git('.', 'add', 'shared.txt');
  git('.', 'commit', '-q', '-m', 'task side');
  const pusher = join(home, 'pusher');
  git(pusher, 'pull', '-q', '--ff-only', 'origin', 'main');
  writeFileSync(join(pusher, mode === 'conflict' ? 'shared.txt' : 'base.txt'), 'base side\n');
  git(pusher, 'add', '-A');
  git(pusher, 'commit', '-q', '-m', `base moved (${mode})`);
  git(pusher, 'push', '-q', 'origin', 'main');
}

if (what === 'setup') setup();
else if (what === 'test') await hangWhile('tests');
else if (what === 'merge-hook') await hangWhile('sync');
else {
  console.error(`crash-hooks: unknown command ${what}`);
  process.exit(2);
}
