// Task commands: add, edit, inspect and move tasks.
import { readFileSync } from 'node:fs';
import * as actions from '#application/actions.ts';
import { type TaskId, asTaskId, parseId } from '#domain/shared/index.ts';
import { isOwnPlanName, modelSourceText, planProgress, shapePrompt } from '#domain/work/index.ts';
import { commentLocation } from '#domain/landing/index.ts';
import { latestVerify, pickRun, runFindings } from '#domain/runs/index.ts';
import { CHECKED_STATUSES, TASK_STATUSES } from '#domain/work/index.ts';
import { filterTasks, listable } from '#domain/work/index.ts';
import { type PlanLink, hasPlanLink, otherPlanOwner, planOwnerOf } from '#domain/work/index.ts';
import { errorMessage, plural } from '#domain/shared/index.ts';
import { callDaemon } from '#cli/operations/daemon-client.ts';
import {
  confirm,
  die,
  idsText,
  taskId,
  taskIds,
  fmtAutoMerge,
  fmtChecks,
  fmtLink,
  fmtProposalCheck,
  fmtRunSummary,
  fmtTask,
  fmtVerifyFindings,
  printLog,
} from '#cli/format.ts';
import type { Command } from '#cli/context.ts';

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    return die(`can't read ${file}: ${errorMessage(e)}`);
  }
}

function planFlag(value: string | undefined): { plan_task?: TaskId | null; plan_html?: string } {
  if (value === undefined) return {};
  const v = value.trim();
  if (!v) return { plan_task: null };
  const task = parseId<TaskId>(v);
  if (task !== null) return { plan_task: task };
  if (/^#?\d+$/.test(v)) return { plan_task: asTaskId(Number(v.replace('#', ''))) };
  return { plan_html: readText(v) };
}

function followedPlanName(t: { id: TaskId; plan: PlanLink | null; plans: { task_id: TaskId; name: string }[] }): string | null {
  const owner = planOwnerOf(t);
  return t.plans.find((p) => p.task_id === owner && isOwnPlanName(owner, p.name))?.name ?? null;
}

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
    const source = modelSourceText(t.model_source);
    console.log(
      `${t.status === 'proposed' ? 'proposed' : 'queued'} task #${t.id} on ${repoName(t.repo_id)} (${t.model}${source ? `: ${source}` : ''}, ${t.max_turns} turns max${links
        .map(fmtLink)
        .map((l) => `, ${l}`)
        .join('')})`,
    );
    const planName = followedPlanName(detail);
    if (planName && hasPlanLink(t)) {
      const other = otherPlanOwner(t);
      console.log(`plan     ${planName}${other === null ? '' : ` (#${other}'s plan)`}`);
    }
    if (waiting?.stuck) console.log(`note: ${waiting.stuck}, so this task won't start until ${idsText(waiting.on)} is retried`);
    for (const w of shapePrompt(t.prompt).warnings) console.log(`warning: ${w}`);
    for (const w of await actions.promptWarnings(db, t.id)) console.log(`note: ${w}`);
    if (t.status === 'proposed') console.log(`note: it waits for \`agentdeck approve ${t.id}\` before it can run`);
    else if (actions.isPaused(db)) console.log('note: the daemon is paused; run `agentdeck resume` to start working');
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
      if (kind === 'builds_on' && e instanceof actions.ActionError && e.code === actions.BUILDS_ON_STARTED)
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
    if (flags.prompt !== undefined) for (const w of shapePrompt(t.prompt).warnings) console.log(`warning: ${w}`);
    for (const w of await actions.promptWarnings(db, t.id)) console.log(`note: ${w}`);
  },
  ls: ({ db, flags, rest, repoName }) => {
    const repo = flags.repo === undefined ? undefined : actions.repoDetail(db, flags.repo);
    const states = (flags.status ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const sort = flags.sort ?? (states.length === 1 && (TASK_STATUSES as string[]).includes(states[0]) ? 'priority' : 'newest');
    const all = actions.withViews(db, actions.listTasks(db)).map(listable);
    let tasks;
    try {
      tasks = filterTasks(all, { states, repo_id: repo?.id, search: rest.join(' '), sort });
    } catch (e) {
      die(errorMessage(e));
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
    if (t.checks) console.log(fmtChecks(t.checks, t.status === 'done' ? t.id : undefined));
    if (t.links.length) console.log(`links    ${t.links.map(fmtLink).join(', ')}`);
    if (t.dependents.length)
      console.log(`needed by ${t.dependents.map((d) => `#${d.id} (${d.kind === 'builds_on' ? 'builds on it' : 'after it'})`).join(', ')}`);
    if (t.checkout?.branch) console.log(`branch   ${t.checkout.branch}`);
    if (t.checkout?.worktree) console.log(`worktree ${t.checkout.worktree}`);
    if (t.status === 'blocked') {
      const { needs, question } = t;
      if (needs) console.log(`needs    ${needs.kind}: ${needs.items.join(' ')}`);
      if (question) {
        console.log(`question ${question.question}`);
        for (const o of question.options) console.log(`         - ${o}`);
      }
    }
    const plan = followedPlanName(t);
    if (plan) {
      const steps = t.plan?.steps ?? null;
      const other = otherPlanOwner(t);
      const whose = other !== null ? `#${other}'s plan, ` : '';
      console.log(`plan     ${plan} (${whose}${steps ? `steps ${steps.join(', ')}` : 'every unfinished step'})`);
    }
    const check = CHECKED_STATUSES.includes(t.status) ? await actions.proposalCheck(db, t.id) : null;
    if (check) for (const line of fmtProposalCheck(check)) console.log(line);
    const verify = latestVerify(t.runs, check?.staleness?.base ?? null);
    if (verify?.stale) console.log(`verify   the base moved on since the verify run read ${verify.commit?.slice(0, 7)}`);
    console.log(`\n${t.prompt}\n`);
    for (const p of t.plans) {
      const { finished, total } = planProgress(p.steps);
      console.log(`plan: ${p.title} (${p.name}${p.task_id === t.id ? '' : ` of #${p.task_id}`}, ${finished}/${total} steps)`);
    }
    for (const r of t.runs) {
      const tokens = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
      console.log(
        `${r.kind === 'work' ? 'run' : `${r.kind} run`} ${r.attempt}: ${r.outcome ?? 'running'}  turns=${r.num_turns ?? '-'}  tokens=${tokens}  tests=${r.tests_passed === null ? '-' : r.tests_passed ? 'pass' : 'fail'}  ${r.started_at}`,
      );
      if (r.summary) for (const line of fmtRunSummary(r.summary)) console.log(`  ${line}`);
      const findings = runFindings(r);
      if (r.kind === 'verify' && r.base_commit) console.log(`  read ${r.base_commit.slice(0, 7)}`);
      if (findings) for (const line of fmtVerifyFindings(findings)) console.log(`  ${line}`);
      else if (r.result_text) console.log(`  ${r.result_text.trim().split('\n').slice(-6).join('\n  ')}`);
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
    if (!actions.findTask(db, id)) die(`no task #${id}`);
    const run = pickRun(actions.taskRuns(db, id), { attempt: flags.attempt ? Number(flags.attempt) : undefined });
    if (!run) die(`#${id} has no runs yet`);
    if (flags.raw) process.stdout.write(readFileSync(run.log_path, 'utf8'));
    else printLog(db, run.log_path);
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
  park: ({ db, flags, rest }) => {
    if (!rest.length) die('usage: agentdeck park <id>... [--reason <text>]');
    for (const arg of rest) {
      const id = taskId(arg);
      actions.parkTask(db, id, flags.reason);
      console.log(`parked #${id}; \`agentdeck lift ${id}\` brings it back`);
    }
  },
  lift: ({ db, rest }) => {
    if (!rest.length) die('usage: agentdeck lift <id>...');
    for (const arg of rest) {
      const id = taskId(arg);
      actions.liftTask(db, id);
      console.log(`lifted #${id}; it is proposed again`);
    }
  },
  cancel: ({ db, rest }) => {
    const id = taskId(rest[0]);
    console.log(actions.cancelTask(db, id) === 'cancelled' ? `cancelled #${id}` : `stopping #${id}…`);
  },
  retry: ({ db, flags, rest }) => {
    const id = taskId(rest[0]);
    const { model, escalated } = actions.retryTask(db, id, {
      note: flags.note,
      model: flags.model,
      max_turns: flags['max-turns'] ? Number(flags['max-turns']) : undefined,
    });
    console.log(escalated ? `requeued #${id}, one model up: ${model}` : `requeued #${id}`);
  },
  done: ({ db, flags, rest }) => {
    const id = taskId(rest[0]);
    actions.markDone(db, id, flags.note);
    console.log(`marked #${id} done`);
  },
  'install-needs': async ({ db, flags, rest }) => {
    const id = taskId(rest[0]);
    const task = actions.findTask(db, id);
    const needs = task?.status === 'blocked' ? task.needs : null;
    if (needs?.kind === 'deps') {
      console.log(`#${id} asks for: ${needs.items.join(' ')}`);
      if (!flags.yes && !(await confirm('install them on its branch and retry?'))) die('not installed');
    }
    const { packages } = await actions.installNeeds(db, id);
    console.log(`installed ${packages.join(' ')} on #${id}'s branch; requeued`);
  },
  sync: async ({ db, rest }) => {
    const id = taskId(rest[0]);
    console.log(`syncing #${id}'s branch with the base branch… (a conflict starts a claude run and can take a while)`);
    const r: actions.SyncReport = await callDaemon('POST', `/api/tasks/${id}/sync`, {});
    const files = plural(r.files.length, 'file');
    const lines: Record<typeof r.outcome, string> = {
      up_to_date: `#${id} is already in sync with the base branch`,
      clean: `#${id}: synced with the base branch, no conflicts`,
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
  verify: async ({ rest }) => {
    const id = taskId(rest[0]);
    console.log(`verify run on #${id}: checking its prompt's claims against the base… (a claude run, a few minutes)`);
    const { report }: { report: actions.VerifyReport | null } = await callDaemon('POST', `/api/tasks/${id}/verify`, { wait: true });
    if (!report) return;
    if (report.outcome !== 'done') {
      console.log(`#${id}: the verify run ended ${report.outcome}${report.reason ? `: ${report.reason}` : ''}`);
      process.exitCode = 1;
      return;
    }
    console.log(`#${id} against ${report.commit?.slice(0, 7) ?? 'the base'}:`);
    for (const line of fmtVerifyFindings(report.findings)) console.log(`  ${line}`);
  },
  clean: async ({ db, rest }) => {
    const { branch } = await actions.removeTaskWorktree(db, taskId(rest[0]));
    console.log(`removed worktree; branch ${branch} kept`);
  },
};

taskCommands.resolve = taskCommands.sync;
