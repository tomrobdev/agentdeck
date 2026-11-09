// Repo commands: register, configure and check repos, goals and the planner.
import { readFileSync } from 'node:fs';
import * as actions from '../../application/actions.ts';
import type { ProposalResult } from '../../domain/proposals/index.ts';
import { callDaemon } from '../operations/daemon-client.ts';
import { confirm, die, fmtTask, printDoctor } from '../format.ts';
import { repoSettingPatch } from '../operations/settings-args.ts';
import type { Command } from '../context.ts';

const propose: Command = async ({ db, rest, repoName }) => {
  if (!rest[0]) die('usage: agentdeck propose <repo>');
  console.log(`proposing tasks for ${rest[0]}…`);
  const repo = actions.repoDetail(db, rest[0]);
  const res: ProposalResult = await callDaemon('POST', `/api/repos/${repo.id}/propose`, {});
  console.log(`${res.outcome}${res.note ? `: ${res.note}` : ''}`);
  for (const t of res.tasks) console.log(fmtTask(t, repoName(t.repo_id)));
  for (const t of res.skipped) console.log(`  skipped (duplicate or over the cap): ${t}`);
  if (res.tasks.some((t) => t.status === 'proposed')) console.log('approve with `agentdeck approve <id>`');
};

/** Which tool rules a repo's workers run with, for a line of output. */
const fmtToolRules = (repo: ReturnType<typeof actions.repoView>): string =>
  repo.tools_source === 'own'
    ? `the repo's own: ${(JSON.parse(repo.allowed_tools ?? '[]') as string[]).join(', ')}`
    : `detected from its toolchain (${repo.toolchain ?? 'none found'}) with the defaults`;

export const repoCommands: Record<string, Command> = {
  repo: async (args) => {
    const { db, cmd, flags, rest } = args;
    const [sub, path] = rest;
    if (sub === 'propose' || sub === 'plan') return propose({ ...args, rest: rest.slice(1) });
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
    } else if (sub === 'archive' || sub === 'unarchive') {
      if (!path) die(`usage: agentdeck repo ${sub} <repo>`);
      const repo = sub === 'archive' ? actions.archiveRepo(db, path) : actions.unarchiveRepo(db, path);
      console.log(`${repo.name}: ${sub}d`);
    } else if (sub === 'delete') {
      if (!path) die('usage: agentdeck repo delete <repo> [--yes]');
      const p = actions.repoDeletionPreview(db, path);
      // An unarchived repo skips the confirmation: deleteRepo refuses it below.
      if (p.archived) {
        console.log(
          `${p.repo}: will delete ${p.tasks} tasks, ${p.runs} runs and ${p.worktrees} worktrees, with their logs and the goals file.`,
        );
        console.log('Nothing on GitHub or the remote is touched; open PRs stay open.');
        if (!flags.yes && !(await confirm(`delete ${p.repo} for good?`))) return void console.log('not deleted');
      }
      const res = await actions.deleteRepo(db, path);
      console.log(`${res.repo}: deleted`);
      for (const l of res.leftover) console.log(`could not remove: ${l}`);
    } else if (sub === 'set') {
      const [, name, key, value = ''] = rest;
      // No repo name means no key either, so the patch is what says how to use the command.
      const patch = repoSettingPatch(name && key, value);
      const repo = actions.updateRepo(db, name, patch);
      if (key === 'tools') console.log(`${name}: tools ${fmtToolRules(repo)}`);
      else console.log(`${name}: ${key} ${value || '(none)'}`);
    } else if (sub === 'ls' || !sub) {
      for (const r of actions.listRepos(db, { archived: !!flags.archived })) {
        const goals = actions.repoDetail(db, r.id).goals.trim() ? 'goals ✓' : 'no goals';
        console.log(
          `${r.name.padEnd(16)} ${r.path}  base=${r.base_branch}  toolchain=${r.toolchain ?? '-'}  setup=${r.setup_cmd ?? '-'}  test=${r.test_cmd ?? '-'}  tools=${r.allowed_tools ? `own(${r.allowed_tools.length})` : 'detected'}  pr=${r.pr_mode}  merge=${r.merge_method}  model=${r.model ?? '-'}  sandbox=${r.sandbox ? `on network=${r.network.join(',') || '-'}` : 'OFF'}  ${goals}${r.auto_approve ? '  auto-approve' : ''}${r.paused_reason ? `  PAUSED (${r.paused_reason})` : ''}`,
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
  propose,
  // `plan` is the old name of `propose`.
  plan: propose,
};
