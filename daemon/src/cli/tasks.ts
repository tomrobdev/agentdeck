// Task commands: add, edit, inspect and move tasks.
import { readFileSync } from 'node:fs';
import * as actions from '../application/actions.ts';
import { unblocksOf, waitingFor } from '../application/dependencies.ts';
import { removeWorktree } from '../adapters/git.ts';
import { planProgress } from '../domain/plan/plan.ts';
import { TASK_STATUSES } from '../domain/task/lifecycle.ts';
import { filterTasks } from '../domain/task/listing.ts';
import { die, taskId, fmtTask, printLog } from './format.ts';
import type { Command } from './context.ts';

/** `approve` and `reject` share one implementation; `cmd` says which was typed. */
const approveOrReject: Command = ({ db, cmd, rest }) => {
  if (!rest.length) die(`usage: agentdeck ${cmd} <id>...`);
  for (const arg of rest) {
    const id = taskId(arg);
    (cmd === 'approve' ? actions.approveTask : actions.rejectTask)(db, id);
    console.log(`${cmd === 'approve' ? 'queued' : 'rejected'} #${id}`);
  }
};

export const taskCommands: Record<string, Command> = {
  add: ({ db, flags, rest, repoName }) => {
    const t = actions.addTask(db, {
      repo: flags.repo,
      prompt: rest.join(' '),
      title: flags.title,
      priority: flags.priority ? Number(flags.priority) : undefined,
      model: flags.model,
      max_turns: flags['max-turns'] ? Number(flags['max-turns']) : undefined,
      max_attempts: flags.attempts ? Number(flags.attempts) : undefined,
      after_task: flags.after ? taskId(flags.after) : undefined,
    });
    console.log(
      `queued task #${t.id} on ${repoName(t.repo_id)} (${t.model}, ${t.max_turns} turns max${t.after_task ? `, after #${t.after_task}` : ''})`,
    );
    const waiting = waitingFor(db, t);
    if (waiting?.stuck) console.log(`note: ${waiting.stuck}, so this task won't start until #${waiting.on} is retried`);
    if (db.isPaused()) console.log('note: the daemon is paused; run `agentdeck resume` to start working');
  },
  edit: ({ db, flags, rest, repoName }) => {
    const id = taskId(rest[0]);
    // A blank or non-numeric value becomes NaN, which editTask rejects.
    const num = (v: string | undefined) => (v === undefined ? undefined : v.trim() === '' ? NaN : Number(v));
    const t = actions.editTask(db, id, {
      title: flags.title,
      prompt: flags.prompt,
      priority: num(flags.priority),
      model: flags.model,
      max_turns: num(flags['max-turns']),
      max_attempts: num(flags.attempts),
    });
    console.log(fmtTask(t, repoName(t.repo_id)));
    console.log(`model ${t.model}, attempts ${t.attempts}/${t.max_attempts}, max turns ${t.max_turns}`);
  },
  ls: ({ db, flags, rest, repoName }) => {
    const repo = flags.repo === undefined ? undefined : (db.findRepo(flags.repo) ?? die(`no repo "${flags.repo}"`));
    const states = (flags.status ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // One status keeps its old order, priority first; anything else lists the newest first.
    const sort = flags.sort ?? (states.length === 1 && (TASK_STATUSES as string[]).includes(states[0]) ? 'priority' : 'newest');
    const all = db.listTasks().map((t) => ({ ...t, waiting: waitingFor(db, t), unblocks: unblocksOf(db, t) }));
    let tasks;
    try {
      tasks = filterTasks(all, { states, repo_id: repo?.id, search: rest.join(' '), sort });
    } catch (e) {
      die((e as Error).message);
    }
    if (!tasks.length) console.log(all.length ? 'no matching tasks' : 'no tasks');
    for (const t of tasks) console.log(fmtTask(t, repoName(t.repo_id)));
    if (tasks.length && tasks.length < all.length) console.log(`${tasks.length} of ${all.length} tasks`);
  },
  show: ({ db, rest, repoName }) => {
    const t = db.getTask(taskId(rest[0])) ?? die('no such task');
    console.log(fmtTask(t, repoName(t.repo_id), db));
    console.log(`model ${t.model}, attempts ${t.attempts}/${t.max_attempts}, max turns ${t.max_turns}`);
    if (t.branch) console.log(`branch   ${t.branch}`);
    if (t.worktree) console.log(`worktree ${t.worktree}`);
    console.log(`\n${t.prompt}\n`);
    for (const p of db.plansForTask(t.id)) {
      const { finished, total } = planProgress(p.steps);
      console.log(`plan: ${p.title} (${p.name}, ${finished}/${total} steps)`);
    }
    for (const r of db.runsForTask(t.id)) {
      const tokens = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
      console.log(
        `run ${r.attempt}: ${r.outcome ?? 'running'}  turns=${r.num_turns ?? '-'}  tokens=${tokens}  tests=${r.tests_passed === null ? '-' : r.tests_passed ? 'pass' : 'fail'}  ${r.started_at}`,
      );
      if (r.result_text) console.log(`  ${r.result_text.trim().split('\n').slice(-6).join('\n  ')}`);
    }
  },
  log: ({ db, flags, rest }) => {
    const t = db.getTask(taskId(rest[0])) ?? die('no such task');
    const runs = db.runsForTask(t.id);
    const run = flags.attempt ? runs.find((r) => r.attempt === Number(flags.attempt)) : runs.at(-1);
    if (!run) die('no runs yet');
    if (flags.raw) process.stdout.write(readFileSync(run.log_path, 'utf8'));
    else printLog(run.log_path);
  },
  attach: async ({ db, rest }) => {
    const id = taskId(rest[0]);
    const file = rest[1];
    const read = (f: string) => {
      try {
        return readFileSync(f, 'utf8');
      } catch (e) {
        return die(`can't read ${f}: ${(e as Error).message}`);
      }
    };
    const plans = file ? [actions.attachPlan(db, id, { name: file, html: read(file) })] : await actions.collectPlans(db, id);
    if (!plans.length) console.log(`no plans on #${id}'s branch`);
    for (const p of plans) {
      const { finished, total } = planProgress(p.steps);
      console.log(`#${id} plan: ${p.title} (${p.name}, ${finished}/${total} steps)`);
    }
  },
  approve: approveOrReject,
  reject: approveOrReject,
  cancel: ({ db, rest }) => {
    const id = taskId(rest[0]);
    console.log(actions.cancelTask(db, id) === 'cancelled' ? `cancelled #${id}` : `stopping #${id}…`);
  },
  retry: ({ db, rest }) => {
    const id = taskId(rest[0]);
    actions.retryTask(db, id);
    console.log(`requeued #${id}`);
  },
  clean: async ({ db, rest }) => {
    const t = db.getTask(taskId(rest[0])) ?? die('no such task');
    if (t.status === 'running' || t.status === 'cancel_requested') die('task is running');
    if (!t.worktree) die('task has no worktree');
    await removeWorktree(db.getRepo(t.repo_id)!, t.worktree);
    db.updateTask(t.id, { worktree: null });
    console.log(`removed worktree; branch ${t.branch} kept`);
  },
};
