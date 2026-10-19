// Repo commands: register, configure and check repos, goals and the planner.
import { readFileSync } from 'node:fs';
import * as actions from '../application/actions.ts';
import type { MergeMethod } from '../domain/pull-request/merge.ts';
import type { PrMode } from '../domain/pull-request/pr.ts';
import { die, fmtTask, printDoctor } from './format.ts';
import type { Command } from './context.ts';

export const repoCommands: Record<string, Command> = {
  repo: async ({ db, cmd, flags, rest }) => {
    const [sub, path] = rest;
    if (sub === 'add') {
      if (!path) die('repo add needs a path');
      const repo = await actions.addRepo(db, {
        path,
        name: flags.name,
        base: flags.base,
        test: flags.test,
        setup: flags.setup,
        tools: flags.tools?.split(',').map((t) => t.trim()),
      });
      console.log(
        `added repo "${repo.name}" (${repo.path}, base ${repo.base_branch}, toolchain ${repo.toolchain ?? 'unknown'}${repo.setup_cmd ? `, setup: ${repo.setup_cmd}` : ''}${repo.test_cmd ? `, tests: ${repo.test_cmd}` : ''})`,
      );
      // The repo is added either way; a failed doctor pauses it and says so, without failing the command.
      printDoctor(await actions.doctorRepo(db, repo.id));
    } else if (sub === 'doctor') {
      if (!path) die('usage: agentdeck repo doctor <repo>');
      console.log(`checking ${path}… (this runs the repo's setup and test commands)`);
      if (!printDoctor(await actions.doctorRepo(db, path)).ok) process.exitCode = 1;
    } else if (sub === 'resume') {
      if (!path) die('usage: agentdeck repo resume <repo>');
      const repo = actions.resumeRepo(db, path);
      console.log(`${repo.name}: resumed`);
    } else if (sub === 'set') {
      const [, name, key, value = ''] = rest;
      if (!name || !['auto_approve', 'base_branch', 'test_cmd', 'setup_cmd', 'pr_mode', 'merge_method'].includes(key))
        die(
          'usage: agentdeck repo set <repo> auto_approve on|off | base_branch <branch> | test_cmd "<cmd>" | setup_cmd "<cmd>" | pr_mode off|draft|ready | merge_method squash|merge|rebase',
        );
      if (key === 'pr_mode') actions.updateRepo(db, name, { pr_mode: value as PrMode });
      else if (key === 'merge_method') actions.updateRepo(db, name, { merge_method: value as MergeMethod });
      else if (key === 'auto_approve')
        actions.updateRepo(db, name, { auto_approve: ['1', 'on', 'true', 'yes'].includes(value.toLowerCase()) });
      else if (key === 'base_branch') actions.updateRepo(db, name, { base_branch: value });
      else if (key === 'setup_cmd') actions.updateRepo(db, name, { setup_cmd: value });
      else actions.updateRepo(db, name, { test_cmd: value });
      console.log(`${name}: ${key} ${value || '(none)'}`);
    } else if (sub === 'ls' || !sub) {
      for (const r of db.listRepos()) {
        const goals = actions.repoDetail(db, r.id).goals.trim() ? 'goals ✓' : 'no goals';
        console.log(
          `${r.name.padEnd(16)} ${r.path}  base=${r.base_branch}  toolchain=${r.toolchain ?? '-'}  setup=${r.setup_cmd ?? '-'}  test=${r.test_cmd ?? '-'}  pr=${r.pr_mode}  merge=${r.merge_method}  ${goals}${r.auto_approve ? '  auto-approve' : ''}${r.paused_reason ? `  PAUSED (${r.paused_reason})` : ''}`,
        );
      }
    } else die(`unknown repo command: ${sub}`);
  },
  goals: ({ db, flags, rest }) => {
    if (!rest[0]) die('usage: agentdeck goals <repo> [--file goals.md]');
    if (flags.file) actions.updateRepo(db, rest[0], { goals: readFileSync(flags.file, 'utf8') });
    const r = actions.repoDetail(db, rest[0]);
    console.log(`# ${r.goals_path}\n`);
    console.log(r.goals.trim() || '(empty: write the outcomes you want, priorities, and what not to touch)');
  },
  plan: async ({ db, rest, repoName }) => {
    if (!rest[0]) die('usage: agentdeck plan <repo>');
    console.log(`planning ${rest[0]}…`);
    const res = await actions.planNow(db, rest[0]);
    console.log(`${res.outcome}${res.note ? `: ${res.note}` : ''}`);
    for (const t of res.tasks) console.log(fmtTask(t, repoName(t.repo_id)));
    for (const t of res.skipped) console.log(`  skipped (duplicate or over the cap): ${t}`);
    if (res.tasks.some((t) => t.status === 'proposed')) console.log('approve with `agentdeck approve <id>`');
  },
};
