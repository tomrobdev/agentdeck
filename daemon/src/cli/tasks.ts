// Task commands: add, edit, inspect and move tasks.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import * as actions from '../application/actions.ts';
import { isOwnPlanName, planProgress } from '../domain/plan/plan.ts';
import { commentLocation } from '../domain/review/review.ts';
import { pickRun } from '../domain/run/run.ts';
import { TASK_STATUSES } from '../domain/task/lifecycle.ts';
import { filterTasks } from '../domain/task/listing.ts';
import { readNeeds } from '../domain/task/needs.ts';
import { isReview } from '../domain/task/stage.ts';
import { planStepIds } from '../domain/task/task.ts';
import { callDaemon } from './daemon-client.ts';
import { die, idsText, taskId, taskIds, fmtAutoMerge, fmtLink, fmtTask, printLog } from './format.ts';
import type { Command } from './context.ts';

/** A file's text, or exit saying why it can't be read. */
function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    return die(`can't read ${file}: ${(e as Error).message}`);
  }
}

/**
 * `--plan`: a task number (`112` or `#112`) links that task's plan; anything else is a plan file, read from anywhere on
 * disk, that the task stores as its own plan. Empty clears the link (edit).
 */
function planFlag(value: string | undefined): { plan_task?: number | null; plan_html?: string } {
  if (value === undefined) return {};
  const v = value.trim();
  if (!v) return { plan_task: null };
  if (/^#?\d+$/.test(v)) return { plan_task: Number(v.replace('#', '')) };
  return { plan_html: readText(v) };
}

/** The name of the plan a task follows, from the plans its detail shows. */
function followedPlanName(t: { id: number; plan_task?: number | null; plans: { task_id: number; name: string }[] }): string | null {
  const owner = t.plan_task ?? t.id;
  return t.plans.find((p) => p.task_id === owner && isOwnPlanName(owner, p.name))?.name ?? null;
}

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
  add: async ({ db, flags, rest, repoName }) => {
    const plan = planFlag(flags.plan);
    const t = await actions.addTask(db, {
      repo: flags.repo,
      prompt: rest.join(' '),
      title: flags.title,
      priority: flags.priority ? Number(flags.priority) : undefined,
      model: flags.model,
      max_turns: flags['max-turns'] ? Number(flags['max-turns']) : undefined,
      max_attempts: flags.attempts ? Number(flags.attempts) : undefined,
      builds_on: taskIds(flags['builds-on'], '--builds-on'),
      after: taskIds(flags.after, '--after'),
      plan_task: plan.plan_task ?? undefined,
      plan_html: plan.plan_html,
      plan_steps: flags.steps,
      propose: flags.propose,
    });
    const detail = await actions.taskDetail(db, t.id);
    const { waiting, links } = detail;
    console.log(
      `${t.status === 'proposed' ? 'proposed' : 'queued'} task #${t.id} on ${repoName(t.repo_id)} (${t.model}, ${t.max_turns} turns max${links
        .map(fmtLink)
        .map((l) => `, ${l}`)
        .join('')})`,
    );
    const planName = followedPlanName(detail);
    if (planName && t.plan_task !== null) console.log(`plan     ${planName}${t.plan_task === t.id ? '' : ` (#${t.plan_task}'s plan)`}`);
    if (waiting?.stuck) console.log(`note: ${waiting.stuck}, so this task won't start until ${idsText(waiting.on)} is retried`);
    for (const w of await actions.promptWarnings(db, t.id)) console.log(`note: ${w}`);
    if (t.status === 'proposed') console.log(`note: it waits for \`agentdeck approve ${t.id}\` before it can run`);
    else if (db.isPaused()) console.log('note: the daemon is paused; run `agentdeck resume` to start working');
  },
  link: async ({ db, flags, rest }) => {
    const id = taskId(rest[0]);
    const kinds = [flags['builds-on'] !== undefined && ('builds_on' as const), flags.after !== undefined && ('after' as const)].filter(
      (k) => k !== false,
    );
    if (kinds.length !== 1 || rest.length !== 1) die('usage: agentdeck link <id> --builds-on <task> | --after <task>');
    const kind = kinds[0];
    const on = taskId(kind === 'builds_on' ? flags['builds-on'] : flags.after);
    try {
      actions.linkTasks(db, id, { on, kind });
    } catch (e) {
      // A builds-on link refused on a started task: the after link it suggests is one flag away.
      if (kind === 'builds_on' && e instanceof actions.ActionError && /after link instead$/.test(e.message))
        die(`${e.message}: agentdeck link ${id} --after ${on}`);
      throw e;
    }
    console.log(`#${id} ${kind === 'builds_on' ? 'builds on' : 'lands after'} #${on}`);
    const { waiting } = await actions.taskDetail(db, id);
    if (waiting?.stuck) console.log(`note: ${waiting.stuck}, so this task won't start until ${idsText(waiting.on)} is retried`);
  },
  unlink: ({ db, rest }) => {
    if (rest.length !== 2) die('usage: agentdeck unlink <id> <task>');
    const [id, on] = [taskId(rest[0]), taskId(rest[1])];
    actions.unlinkTasks(db, id, on);
    console.log(`#${id} no longer depends on #${on}`);
  },
  edit: async ({ db, flags, rest, repoName }) => {
    const id = taskId(rest[0]);
    // A blank or non-numeric value becomes NaN, which editTask rejects.
    const num = (v: string | undefined) => (v === undefined ? undefined : v.trim() === '' ? NaN : Number(v));
    const t = await actions.editTask(db, id, {
      title: flags.title,
      prompt: flags.prompt,
      priority: num(flags.priority),
      model: flags.model,
      max_turns: num(flags['max-turns']),
      max_attempts: num(flags.attempts),
      ...planFlag(flags.plan),
      plan_steps: flags.steps,
    });
    console.log(fmtTask(t, repoName(t.repo_id)));
    console.log(`model ${t.model}, attempts ${t.attempts}/${t.max_attempts}, max turns ${t.max_turns}`);
    for (const w of await actions.promptWarnings(db, t.id)) console.log(`note: ${w}`);
  },
  ls: ({ db, flags, rest, repoName }) => {
    const repo = flags.repo === undefined ? undefined : actions.repoDetail(db, flags.repo);
    const states = (flags.status ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // One status keeps its old order, priority first; anything else lists the newest first.
    const sort = flags.sort ?? (states.length === 1 && (TASK_STATUSES as string[]).includes(states[0]) ? 'priority' : 'newest');
    const all = actions.withViews(db, db.listTasks());
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
  show: async ({ db, rest, repoName }) => {
    const t = await actions.taskDetail(db, taskId(rest[0]));
    console.log(fmtTask(t, repoName(t.repo_id)));
    console.log(`model ${t.model}, attempts ${t.attempts}/${t.max_attempts}, max turns ${t.max_turns}`);
    if (t.auto_merge_view) for (const line of fmtAutoMerge(t.auto_merge_view)) console.log(line);
    if (t.links.length) console.log(`links    ${t.links.map(fmtLink).join(', ')}`);
    if (t.dependents.length)
      console.log(`needed by ${t.dependents.map((d) => `#${d.id} (${d.kind === 'builds_on' ? 'builds on it' : 'after it'})`).join(', ')}`);
    if (t.branch) console.log(`branch   ${t.branch}`);
    if (t.worktree) console.log(`worktree ${t.worktree}`);
    const needs = readNeeds(t.needs);
    if (needs && t.status === 'blocked') console.log(`needs    ${needs.kind}: ${needs.items.join(' ')}`);
    const plan = followedPlanName(t);
    if (plan) {
      const steps = planStepIds(t);
      const whose = t.plan_task !== null && t.plan_task !== t.id ? `#${t.plan_task}'s plan, ` : '';
      console.log(`plan     ${plan} (${whose}${steps ? `steps ${steps.join(', ')}` : 'every unfinished step'})`);
    }
    console.log(`\n${t.prompt}\n`);
    for (const p of t.plans) {
      const { finished, total } = planProgress(p.steps);
      console.log(`plan: ${p.title} (${p.name}${p.task_id === t.id ? '' : ` of #${p.task_id}`}, ${finished}/${total} steps)`);
    }
    for (const r of db.runsForTask(t.id)) {
      const tokens = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
      console.log(
        `${r.kind === 'resolve' ? 'conflict run' : 'run'} ${r.attempt}: ${r.outcome ?? 'running'}  turns=${r.num_turns ?? '-'}  tokens=${tokens}  tests=${r.tests_passed === null ? '-' : r.tests_passed ? 'pass' : 'fail'}  ${r.started_at}`,
      );
      if (r.result_text) console.log(`  ${r.result_text.trim().split('\n').slice(-6).join('\n  ')}`);
    }
  },
  review: ({ db, rest }) => {
    const id = taskId(rest[0]);
    const reviews = actions.taskReviews(db, id);
    if (!reviews.length) console.log(`no reviews on #${id}`);
    for (const r of reviews) {
      console.log(
        `review ${r.id}: ${r.submitted_at ? `${r.kind === 'request_changes' ? 'changes requested' : 'comment'}, ${r.submitted_at}` : 'draft'}`,
      );
      if (r.body.trim()) console.log(`  ${r.body.trim().split('\n').join('\n  ')}`);
      for (const c of r.comments) {
        console.log(`  comment ${c.id} [${c.state}] ${commentLocation(c)} @ ${c.head_commit.slice(0, 7)}: ${c.body}`);
        if (c.answer) console.log(`    answer: ${c.answer}`);
      }
    }
  },
  log: ({ db, flags, rest }) => {
    const id = taskId(rest[0]);
    if (!db.getTask(id)) die(`no task #${id}`);
    const run = pickRun(db.runsForTask(id), { attempt: flags.attempt ? Number(flags.attempt) : undefined });
    if (!run) die(`#${id} has no runs yet`);
    if (flags.raw) process.stdout.write(readFileSync(run.log_path, 'utf8'));
    else printLog(run.log_path);
  },
  attach: ({ db, rest }) => {
    if (rest.length !== 2) die('usage: agentdeck attach <id> <plan file>');
    const id = taskId(rest[0]);
    const p = actions.attachPlan(db, id, { html: readText(rest[1]) });
    const { finished, total } = planProgress(p.steps);
    console.log(`#${id} plan: ${p.title} (${p.name}, ${finished}/${total} steps)`);
  },
  approve: approveOrReject,
  reject: approveOrReject,
  cancel: ({ db, rest }) => {
    const id = taskId(rest[0]);
    console.log(actions.cancelTask(db, id) === 'cancelled' ? `cancelled #${id}` : `stopping #${id}…`);
  },
  retry: ({ db, flags, rest }) => {
    const id = taskId(rest[0]);
    actions.retryTask(db, id, flags.note);
    console.log(`requeued #${id}`);
  },
  done: ({ db, flags, rest }) => {
    const id = taskId(rest[0]);
    actions.markDone(db, id, flags.note);
    console.log(`marked #${id} done`);
  },
  'install-needs': async ({ db, flags, rest }) => {
    const id = taskId(rest[0]);
    // Without a package request there is nothing to confirm: installNeeds says why.
    const needs = readNeeds(db.getTask(id)?.needs ?? null);
    if (needs?.kind === 'deps') {
      console.log(`#${id} asks for: ${needs.items.join(' ')}`);
      if (!flags.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question('install them on its branch and retry? [y/N] ');
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) die('not installed');
      }
    }
    const { packages } = await actions.installNeeds(db, id);
    console.log(`installed ${packages.join(' ')} on #${id}'s branch; requeued`);
  },
  'close-pr': async ({ db, rest }) => {
    const id = taskId(rest[0]);
    await actions.closeTaskPr(db, id);
    console.log(`closed the pull request of #${id}`);
  },
  merge: async ({ db, flags, rest }) => {
    if (flags.all) {
      const review = db.openPrTasks().filter(isReview);
      if (!review.length) return void console.log('no pull requests in review');
      for (const t of review) console.log(`#${t.id}  ${t.title}`);
      if (!flags.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`merge ${review.length === 1 ? 'this PR' : `these ${review.length} PRs`}? [y/N] `);
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) return void console.log('not merged');
      }
      const res = await actions.mergeAll(db, { ids: review.map((t) => t.id) });
      for (const m of res.merged) {
        console.log(
          `merged #${m.id} (${m.method})${m.unblocked.length ? `; ${m.unblocked.map((n) => `#${n}`).join(', ')} can start` : ''}`,
        );
        if (m.cleanup_error) console.log(`  cleanup incomplete: ${m.cleanup_error}`);
      }
      for (const s of res.skipped) console.log(`left #${s.id}: ${s.reason}`);
      return;
    }
    const id = taskId(rest[0]);
    const preview = await actions.mergePreview(db, id);
    const method = flags.method ?? preview.method;
    const { commits, files, additions, deletions, checks } = preview;
    console.log(`${preview.title}  #${id}`);
    console.log(`${preview.pr_url}`);
    console.log(
      `${preview.branch ?? '?'} → ${preview.base}, ${method}${method === 'squash' ? ` (${commits} → 1 commit)` : `, ${commits} commits`}`,
    );
    console.log(`${files} files, +${additions} −${deletions}`);
    const tests = preview.tests_passed === null ? 'not run' : preview.tests_passed ? 'passed' : 'FAILED';
    console.log(
      `tests ${tests}; GitHub checks: ${checks.total ? `${checks.total} (${checks.failing} failing, ${checks.pending} running)` : 'none'}`,
    );
    if (preview.unblocks.length) console.log(`unblocks ${preview.unblocks.map((t) => `#${t.id}`).join(', ')}`);
    for (const w of preview.warnings) console.log(`warning: ${w}`);
    for (const p of preview.problems) console.log(`problem: ${p}`);
    if (preview.problems.length) die(`can't merge #${id}`);
    if (!flags.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`merge into ${preview.base} with ${method}? [y/N] `);
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) return void console.log('not merged');
    }
    const res = await actions.mergeTask(db, id, { method, delete_branch: !flags['keep-branch'] });
    console.log(
      `merged #${id} (${res.method})${res.unblocked.length ? `; ${res.unblocked.map((n) => `#${n}`).join(', ')} can start` : ''}`,
    );
    if (res.cleanup_error) console.log(`cleanup incomplete: ${res.cleanup_error}`);
  },
  'auto-merge': async ({ db, rest }) => {
    const id = taskId(rest[0]);
    const value = { on: true, off: false, repo: null }[rest[1] as 'on' | 'off' | 'repo'];
    if (value === undefined) die('usage: agentdeck auto-merge <id> on|off|repo');
    const res = await actions.setAutoMerge(db, id, { auto_merge: value });
    console.log(`#${id}: auto-merge ${res.auto_merge ? 'on' : 'off'}${value === null ? " (the repo's setting)" : ''}`);
    if (res.label_error) console.log(`could not change the PR's label: ${res.label_error}`);
  },
  sync: async ({ db, rest }) => {
    const id = taskId(rest[0]);
    console.log(`syncing #${id}'s branch with the base branch… (a conflict starts a claude run and can take a while)`);
    const r: actions.SyncReport = await callDaemon('POST', `/api/tasks/${id}/resolve`, {});
    const files = `${r.files.length} ${r.files.length === 1 ? 'file' : 'files'}`;
    const lines: Record<typeof r.outcome, string> = {
      up_to_date: `#${id} is already up to date`,
      clean: `#${id}: brought in the base branch, no conflicts`,
      resolved: `#${id}: resolved conflicts in ${files}: ${r.files.join(', ')}`,
      blocked: `#${id} is now blocked: ${r.reason}`,
      skipped: `#${id} conflicts in ${files} (${r.files.join(', ')}), but ${r.reason}`,
      deferred: `#${id} not done: ${r.reason}`,
      error: `#${id}: ${r.reason}`,
    };
    console.log(lines[r.outcome]);
    if (r.pushed) console.log('pushed; the pull request has it');
    if (r.push_error) console.log(`push failed: ${r.push_error}`);
    if (r.outcome === 'blocked') process.exitCode = 1;
  },
  clean: async ({ db, rest }) => {
    const { branch } = await actions.removeTaskWorktree(db, taskId(rest[0]));
    console.log(`removed worktree; branch ${branch} kept`);
  },
};

// `resolve` is the old name of `sync`.
taskCommands.resolve = taskCommands.sync;
