import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ALWAYS_DISALLOWED_TOOLS, DEFAULT_ALLOWED_TOOLS } from '../src/config.ts';
import type { Repo, Task } from '../src/db.ts';
import { normalizeNetwork, parseNetwork, workerSettings, worktreeFileRules } from '../src/domain/sandbox.ts';
import { claudeArgs, settingsPath, writeRunSettings } from '../src/worker.ts';

const wt = '/Users/me/.agentdeck/worktrees/demo/task-7';

test('file rules cover the worktree by absolute path (// prefix)', () => {
  assert.deepEqual(worktreeFileRules(wt), [`Edit(/${wt}/**)`, `Write(/${wt}/**)`]);
  assert.deepEqual(worktreeFileRules(`${wt}/`), worktreeFileRules(wt));
  assert.ok(worktreeFileRules(wt)[0].startsWith('Edit(//Users/'));
});

test('sandbox on: enabled, no fallback, strict allowlist from the repo', () => {
  assert.deepEqual(workerSettings({ worktree: wt, sandbox: true, network: [] }), {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true },
    },
    permissions: { allow: [`Edit(/${wt}/**)`, `Write(/${wt}/**)`] },
  });
  const net = workerSettings({ worktree: wt, sandbox: true, network: ['registry.npmjs.org', '*.github.com'] });
  assert.deepEqual(net.sandbox.network, { allowedDomains: ['registry.npmjs.org', '*.github.com'], strictAllowlist: true });
});

test('sandbox off: disabled, file tools still limited to the worktree', () => {
  assert.deepEqual(workerSettings({ worktree: wt, sandbox: false, network: ['github.com'] }), {
    sandbox: { enabled: false },
    permissions: { allow: [`Edit(/${wt}/**)`, `Write(/${wt}/**)`] },
  });
});

test('network lists parse and normalize', () => {
  assert.deepEqual(parseNetwork('["a.com","b.org"]'), ['a.com', 'b.org']);
  assert.deepEqual(parseNetwork(null), []);
  assert.deepEqual(parseNetwork('not json'), []);
  assert.deepEqual(parseNetwork('{"a":1}'), []);
  assert.deepEqual(normalizeNetwork(' a.com, b.org  a.com '), ['a.com', 'b.org']);
  assert.deepEqual(normalizeNetwork(''), []);
});

test('claudeArgs passes --settings and drops bare Edit/Write; push stays disallowed', () => {
  const task = { model: 'sonnet', max_turns: 10 } as Task;
  const args = claudeArgs(task, [...DEFAULT_ALLOWED_TOOLS, 'Edit(src/**)'], 'do it', '/logs/task-1-attempt-1.settings.json');
  assert.equal(args[args.indexOf('--settings') + 1], '/logs/task-1-attempt-1.settings.json');
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.ok(!allowed.includes('Edit') && !allowed.includes('Write'), 'unscoped file tools would allow any path');
  assert.ok(allowed.includes('Read') && allowed.includes('Edit(src/**)'));
  const disallowed = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--append-system-prompt'));
  assert.deepEqual(disallowed, ALWAYS_DISALLOWED_TOOLS);
  assert.ok(disallowed.includes('Bash(git push*)') && disallowed.includes('Bash(git remote*)'));
});

test('the settings file is written next to the run log with the repo’s sandbox settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-sandbox-'));
  const log = join(dir, 'task-3-attempt-2.jsonl');
  assert.equal(settingsPath(log), join(dir, 'task-3-attempt-2.settings.json'));
  const repo = { sandbox: 1, network: '["registry.npmjs.org"]' } as Repo;

  const on = JSON.parse(readFileSync(writeRunSettings(repo, wt, log), 'utf8'));
  assert.deepEqual(on, workerSettings({ worktree: wt, sandbox: true, network: ['registry.npmjs.org'] }));
  const off = JSON.parse(readFileSync(writeRunSettings({ ...repo, sandbox: 0 }, wt, log), 'utf8'));
  assert.deepEqual(off.sandbox, { enabled: false });
});
