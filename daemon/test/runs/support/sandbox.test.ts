import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runSettings } from '#application/runs/claude-run.ts';
import type { Repo } from '#domain/repos/repo.ts';
import { ALWAYS_DISALLOWED_TOOLS, DEFAULT_ALLOWED_TOOLS } from '#domain/repos/tools.ts';
import { claudeArgs, workerSystemPrompt } from '#domain/runs/prompt.ts';
import { plannerArgs } from '#domain/proposals/index.ts';
import { PR_SUMMARY_FORMAT } from '#domain/landing/pull-request/summary.ts';
import { normalizeNetwork, settingsPath, workerSettings, worktreeFileRules } from '#domain/runs/translate/sandbox.ts';
import type { Task } from '#domain/work/task/task.ts';
import { openDb } from '#db/index.ts';
import { testApp } from '#test/fixtures/fixtures.ts';

const wt = '/Users/me/.agentdeck/worktrees/demo/task-7';

test('file rules cover the worktree by absolute path (// prefix)', () => {
  assert.deepEqual(worktreeFileRules(wt), [`Edit(/${wt}/**)`]);
  assert.deepEqual(worktreeFileRules(`${wt}/`), worktreeFileRules(wt));
  assert.ok(worktreeFileRules(wt)[0].startsWith('Edit(//Users/'));
});

test('sandbox on: enabled, no fallback, strict allowlist from the repo', () => {
  assert.deepEqual(workerSettings({ worktree: wt, sandbox: true, network: [] }), {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: true },
    },
    permissions: { allow: [`Edit(/${wt}/**)`] },
  });
  const net = workerSettings({ worktree: wt, sandbox: true, network: ['registry.npmjs.org', '*.github.com'] });
  assert.deepEqual(net.sandbox.network, {
    allowedDomains: ['registry.npmjs.org', '*.github.com'],
    strictAllowlist: true,
    allowLocalBinding: true,
  });
});

test('sandbox off: disabled, file tools still limited to the worktree', () => {
  assert.deepEqual(workerSettings({ worktree: wt, sandbox: false, network: ['github.com'] }), {
    sandbox: { enabled: false },
    permissions: { allow: [`Edit(/${wt}/**)`] },
  });
});

test('network lists normalize', () => {
  assert.deepEqual(normalizeNetwork(' a.com, b.org  a.com '), ['a.com', 'b.org']);
  assert.deepEqual(normalizeNetwork(''), []);
});

test('claudeArgs passes --settings and drops bare Edit/Write; push stays disallowed', () => {
  const task = { model: 'sonnet', max_turns: 10 } as Task;
  const args = claudeArgs(task, [...DEFAULT_ALLOWED_TOOLS, 'Edit(src/**)'], 'do it', null, '/logs/task-1-attempt-1.settings.json');
  assert.equal(args[args.indexOf('--settings') + 1], '/logs/task-1-attempt-1.settings.json');
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.ok(!allowed.includes('Edit') && !allowed.includes('Write'), 'unscoped file tools would allow any path');
  assert.ok(allowed.includes('Read') && allowed.includes('Edit(src/**)'));
  const disallowed = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--append-system-prompt'));
  assert.deepEqual(disallowed, ALWAYS_DISALLOWED_TOOLS);
  assert.ok(disallowed.includes('Bash(git push*)') && disallowed.includes('Bash(git remote*)'));
});

test('worker and planner runs load no MCP servers of the person’s own', () => {
  const task = { model: 'sonnet', max_turns: 10 } as Task;
  assert.ok(claudeArgs(task, ['Read'], 'do it', null, '/s.json').includes('--strict-mcp-config'));
  assert.ok(plannerArgs('propose', 'sonnet').includes('--strict-mcp-config'));
});

test('the worker prompt says sandbox-only test failures are no reason to block', () => {
  const prompt = workerSystemPrompt('pnpm test');
  assert.match(prompt, /AgentDeck runs `pnpm test` again outside it/);
  assert.match(prompt, /not a reason to stop: fix every other failure, then finish with STATUS: DONE/);
  assert.doesNotMatch(workerSystemPrompt(null), /again outside it/);
});

test('the worker prompt asks for the summary format before the STATUS line', () => {
  const prompt = workerSystemPrompt('pnpm test');
  assert.ok(prompt.includes(PR_SUMMARY_FORMAT));
  for (const h of ['## Overview', '## Frontend', '## Backend']) assert.ok(PR_SUMMARY_FORMAT.includes(h));
  assert.ok(prompt.indexOf(PR_SUMMARY_FORMAT) < prompt.indexOf('End your final message with exactly one line'));
  assert.match(prompt, /BLOCKED message is free-form/);
});

test('the settings file is written next to the run log with the repo’s sandbox settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-sandbox-'));
  const log = join(dir, 'task-3-attempt-2.jsonl');
  assert.equal(settingsPath(log), join(dir, 'task-3-attempt-2.settings.json'));
  const repo = { sandbox: true, network: ['registry.npmjs.org'] } as Repo;

  const app = testApp(openDb(':memory:'));

  const on = JSON.parse(readFileSync(runSettings(app, repo, wt, log), 'utf8'));
  assert.deepEqual(on, workerSettings({ worktree: wt, sandbox: true, network: ['registry.npmjs.org'] }));
  const off = JSON.parse(readFileSync(runSettings(app, { ...repo, sandbox: false }, wt, log), 'utf8'));
  assert.deepEqual(off.sandbox, { enabled: false });
});
