// Parent issues labelled agentdeck:plan: each becomes a plan owned by a parked task, with a plan branch its sub-issues' tasks target, and hears what its plan branch does.
import type { App } from '#application/ports/app.ts';
import type { Repo } from '#domain/repos/index.ts';
import type { TaskId } from '#domain/shared/index.ts';
import {
  type Issue,
  type TaskIssue,
  ISSUE_LABELS,
  NOT_STARTED_STATUSES,
  duePlanIssueWrite,
  isLivePlanBranch,
  planBranchName,
  planIntake,
  planOwnerParkReason,
  signed,
  tasksToTarget,
} from '#domain/work/index.ts';
import { addTask, editTask } from '#application/work/tasks.ts';
import { abandonPlanBranch } from '#application/work/plans.ts';
import { parkTask, rejectTask } from '#application/landing/person-events.ts';

type Log = (msg: string) => void;

export function planOfIssue(app: App, repo: Repo, number: number): TaskId | undefined {
  const id = app.taskOfIssue(repo.id, number);
  return id !== undefined && app.planBranchesOfPlan(id).some(isLivePlanBranch) ? id : undefined;
}

export const isPlanIssueLink = (app: App, link: Pick<TaskIssue, 'task_id'>): boolean => app.planBranchesOfPlan(link.task_id).length > 0;

async function moveSubIssues(app: App, repo: Repo, owner: TaskId, target: string, subs: Issue[], log: Log): Promise<void> {
  const tasks = subs.flatMap((i) => {
    const t = app.taskOfIssue(repo.id, i.number);
    const task = t === undefined ? undefined : app.getTask(t);
    return task && NOT_STARTED_STATUSES.includes(task.status) ? [task] : [];
  });
  const moving = tasksToTarget(tasks.map((t) => ({ id: t.id, target: t.target, started: !!t.checkout?.branch, running: false })));
  for (const id of moving) {
    await editTask(app, id, { plan_task: owner, target })
      .then(() => log(`task #${id}: moved onto ${target}`))
      .catch((err) => log(`task #${id}: not moved onto ${target}: ${err}`));
  }
}

async function takeInPlan(app: App, repo: Repo, issue: Issue, open: Issue[], allowed: string[], log: Log): Promise<void> {
  let id = app.taskOfIssue(repo.id, issue.number);
  if (id !== undefined && app.getTask(id)?.status === 'proposed' && !app.ownPlan(id)) {
    rejectTask(app, id);
    app.unlinkIssue(id);
    id = undefined;
  }
  if (id === undefined) {
    const by = await app.issues.labelledBy(repo.path, issue.number, ISSUE_LABELS.plan);
    const intake = planIntake(issue, { labelledBy: by, allowed });
    if (intake.kind === 'refuse') {
      await app.issues.editLabels(repo.path, issue.number, { add: [], remove: [ISSUE_LABELS.plan] });
      await app.issues.comment(repo.path, issue.number, signed(intake.comment));
      log(`${repo.name} issue #${issue.number}: plan label from ${by ?? 'nobody'} taken off`);
      return;
    }
    const task = await addTask(
      app,
      { repo: repo.name, title: intake.title, prompt: intake.prompt, plan_html: intake.html, propose: true },
      { source: 'issue', issue: { number: issue.number, url: issue.url } },
    );
    id = task.id;
  }
  const owner = app.getTask(id);
  if (!owner || app.planBranchesOfPlan(id).length) return;
  if (owner.status === 'proposed') parkTask(app, id, planOwnerParkReason(issue.number));
  if (app.getTask(id)?.status !== 'parked') return;
  const name = planBranchName(id, owner.title);
  app.openPlanBranch({ plan_task: id, repo_id: repo.id, name, base: repo.base_branch }, []);
  log(`${repo.name} issue #${issue.number}: opened as plan #${id} on ${name}`);
  await moveSubIssues(
    app,
    repo,
    id,
    name,
    open.filter((i) => i.parent?.number === issue.number),
    log,
  );
}

export async function takeInPlans(app: App, repo: Repo, plans: Issue[], open: Issue[], allowed: string[], log: Log): Promise<void> {
  for (const issue of plans) {
    await takeInPlan(app, repo, issue, open, allowed, log).catch((err) =>
      log(`${repo.name} issue #${issue.number}: not taken in as a plan: ${err}`),
    );
  }
}

export async function followPlan(app: App, repo: Repo, link: TaskIssue, listed: Issue | undefined, now: number, log: Log): Promise<void> {
  const branch = app.planBranchOf(link.task_id, repo.id);
  const issue = branch && (listed ?? (await app.issues.issue(repo.path, link.number)));
  if (!branch || !issue) return;
  const write = duePlanIssueWrite(link.task_id, issue, branch, link.reported);
  if (!write) return;
  if (write.abandon) {
    abandonPlanBranch(app, link.task_id);
    rejectTask(app, link.task_id);
    log(`plan #${link.task_id}: ${branch.name} abandoned, issue #${link.number} is no longer a plan`);
  }
  if (write.close) await app.issues.close(repo.path, link.number, signed(write.comment), 'completed');
  else await app.issues.comment(repo.path, link.number, signed(write.comment));
  app.reportIssue(link.task_id, write.to, new Date(now).toISOString());
}
