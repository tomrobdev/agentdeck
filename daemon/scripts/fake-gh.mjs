#!/usr/bin/env node
// Fake `gh` for the crash test's PR scenario. Logs each `pr create` to $FAKE_GH_DIR/gh-calls.jsonl. While
// $FAKE_GH_DIR/gh-hang exists, `pr create` writes its pid to $FAKE_GH_DIR/gh-hanging and never returns, so the test can
// kill the daemon between a task reaching done and its PR opening; otherwise it prints the PR's URL.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_GH_DIR;
const [cmd, sub] = process.argv.slice(2);
const rec = (kind) => appendFileSync(join(dir, 'gh-calls.jsonl'), JSON.stringify({ kind, pid: process.pid, t: Date.now() }) + '\n');

if (cmd === 'pr' && sub === 'create') {
  rec('create_start');
  if (existsSync(join(dir, 'gh-hang'))) {
    writeFileSync(join(dir, 'gh-hanging'), String(process.pid));
    setInterval(() => {}, 1000);
  } else {
    rec('created');
    process.stdout.write('https://github.com/demo/demo/pull/1\n');
  }
}
// Anything else (auth status, label create) succeeds with no output.
