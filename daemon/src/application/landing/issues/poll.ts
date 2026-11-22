// The issue poll: for each issue-backed repo, labelled issues become tasks and the other open ones proposals, a person's changes on an issue reach its task, and the issue is told what its task did.
import type { App } from '#application/ports/app.ts';
import type { Repo } from '#domain/repos/index.ts';
import {
  type Issue,
  type TaskIssue,
  ISSUE_LABELS,
  dueIssueWrite,
  isAllowed,
  isFinalReport,
  issueIntake,
  issueMove,
  issueNote,
  labelRefusal,
  proposalIntake,
  signed,
} from '#domain/work/index.ts';
import { addTask, editTask } from '#application/work/tasks.ts';
import { approveTask, cancelTask, rejectTask, retryTask } from '#application/landing/person-events.ts';
import { followPlan, isPlanIssueLink, planOfIssue, takeInPlans } from '#application/landing/issues/plan-issues.ts';

export const ISSUE_POLL_MS = 120_000;

type Log = (msg: string) => void;

const LABELS = [
  { name: ISSUE_LABELS.ready, description: 'AgentDeck may work on this issue', color: '0e8a16' },
  { name: ISSUE_LABELS.info, description: 'AgentDeck asked a question on this issue', color: 'd876e3' },
  { name: ISSUE_LABELS.human, description: 'A person, not AgentDeck, does this issue', color: 'fbca04' },
  { name: ISSUE_LABELS.running, description: 'An AgentDeck run is working on this issue', color: '1d76db' },
  { name: ISSUE_LABELS.plan, description: "AgentDeck lands this issue's sub-issues together as one plan", color: '5319e7' },
  { name: ISSUE_LABELS.parked, description: 'Parked in AgentDeck until a person lifts it', color: 'c5def5' },
  { name: ISSUE_LABELS.ignore, description: 'AgentDeck does not propose this issue', color: 'ededed' },
];

async function allowedLogins(app: App, repo: Repo): Promise<string[]> {
  return repo.issues_allow.length ? repo.issues_allow : [await app.issues.whoami(repo.path)];
}

async function withParent(app: App, repo: Repo, issue: Issue): Promise<Issue> {
  if (!issue.parent || issue.parent.body) return issue;
  const parent = await app.issues.issue(repo.path, issue.parent.number);
  return parent ? { ...issue, parent: { number: parent.number, title: parent.title, body: parent.body } } : issue;
}

async function refuseLabel(app: App, repo: Repo, number: number, comment: string): Promise<void> {
  await app.issues.editLabels(repo.path, number, { add: [], remove: [ISSUE_LABELS.ready] });
  await app.issues.comment(repo.path, number, signed(comment));
}

async function takeIn(app: App, repo: Repo, labelled: Issue[], allowed: string[], log: Log): Promise<void> {
  for (const issue of labelled) {
    if (app.taskOfIssue(repo.id, issue.number) !== undefined) continue;
    await takeInOne(app, repo, issue, allowed, log).catch((err) => log(`${repo.name} issue #${issue.number}: not taken in: ${err}`));
  }
}

async function takeInOne(app: App, repo: Repo, issue: Issue, allowed: string[], log: Log): Promise<void> {
  const by = await app.issues.labelledBy(repo.path, issue.number, ISSUE_LABELS.ready);
  const intake = issueIntake(await withParent(app, repo, issue), {
    labelledBy: by,
    allowed,
    taskOf: (n) => app.taskOfIssue(repo.id, n),
    planOf: (n) => planOfIssue(app, repo, n),
  });
  if (intake.kind === 'wait') return log(`${repo.name} issue #${issue.number}: waits, ${intake.reason}`);
  if (intake.kind === 'refuse') {
    await refuseLabel(app, repo, issue.number, intake.comment);
    log(`${repo.name} issue #${issue.number}: label from ${by ?? 'nobody'} taken off`);
    return;
  }
  const task = await addTask(
    app,
    {
      repo: repo.name,
      title: intake.title,
      prompt: intake.prompt,
      builds_on: intake.builds_on,
      ...(intake.plan_task === null ? {} : { plan_task: intake.plan_task }),
    },
    { source: 'issue', issue: { number: issue.number, url: issue.url } },
  );
  log(`${repo.name} issue #${issue.number}: queued as task #${task.id}`);
}

async function propose(app: App, repo: Repo, open: Issue[], now: string, log: Log): Promise<void> {
  for (const issue of [...open].sort((a, b) => a.number - b.number)) {
    if (app.taskOfIssue(repo.id, issue.number) !== undefined) continue;
    const intake = proposalIntake(await withParent(app, repo, issue), {
      taskOf: (n) => app.taskOfIssue(repo.id, n),
      planOf: (n) => planOfIssue(app, repo, n),
    });
    if (intake?.kind !== 'add') continue;
    const task = await addTask(
      app,
      {
        repo: repo.name,
        title: intake.title,
        prompt: intake.prompt,
        propose: true,
        builds_on: intake.builds_on,
        ...(intake.plan_task === null ? {} : { plan_task: intake.plan_task }),
      },
      { source: 'issue', issue: { number: issue.number, url: issue.url } },
    ).catch((err) => log(`${repo.name} issue #${issue.number}: not proposed: ${err}`));
    if (!task) continue;
    app.reportIssue(task.id, 'proposed', now);
    log(`${repo.name} issue #${issue.number}: proposed as task #${task.id}`);
  }
}

async function allowedLabel(app: App, repo: Repo, link: TaskIssue, allowed: string[]): Promise<string | null> {
  const by = await app.issues.labelledBy(repo.path, link.number, ISSUE_LABELS.ready);
  if (isAllowed(allowed, by)) return by;
  await refuseLabel(app, repo, link.number, labelRefusal(allowed, by));
  return null;
}

async function follow(
  app: App,
  repo: Repo,
  link: TaskIssue,
  listed: Issue | undefined,
  allowed: string[],
  now: number,
  log: Log,
): Promise<void> {
  const before = app.getTask(link.task_id);
  const read = before && (listed ?? (await app.issues.issue(repo.path, link.number)));
  if (!before || !read) return;
  const followsText = before.status === 'queued' || before.status === 'proposed' || before.status === 'parked';
  const issue = followsText ? await withParent(app, repo, read) : read;
  const move = issueMove(before, issue, link);
  if (move.kind === 'cancel') {
    cancelTask(app, before.id);
    log(`task #${before.id}: cancelled, ${move.reason}`);
  } else if (move.kind === 'drop') {
    rejectTask(app, before.id);
    app.unlinkIssue(before.id);
    log(`task #${before.id}: proposal dropped, ${move.reason}`);
    return;
  } else if (move.kind === 'edit') await editTask(app, before.id, { title: move.title, prompt: move.prompt }, 'issue');
  else if (move.kind === 'refuse') {
    await refuseLabel(app, repo, link.number, move.comment);
    log(`task #${before.id}: issue #${link.number} labelled while parked, label taken off`);
    return;
  } else if (move.kind === 'approve') {
    if (!(await allowedLabel(app, repo, link, allowed))) return log(`task #${before.id}: not approved, label taken off`);
    approveTask(app, before.id);
    log(`task #${before.id}: approved from issue #${link.number}`);
  } else if (move.kind === 'retry') {
    if (!(await allowedLabel(app, repo, link, allowed))) return log(`task #${before.id}: not retried, label taken off`);
    const note = issueNote(await app.issues.comments(repo.path, link.number), link.reported_at, allowed);
    retryTask(app, before.id, { note });
    log(`task #${before.id}: retried from issue #${link.number}`);
  }
  const task = app.getTask(link.task_id);
  const write = task && dueIssueWrite(task, link, issue, repo.pr_mode !== 'off');
  if (!task || !write) return;
  await app.issues.editLabels(repo.path, link.number, write);
  if (write.close) await app.issues.close(repo.path, link.number, signed(write.comment), write.close_as ?? 'completed');
  else if (write.comment) await app.issues.comment(repo.path, link.number, signed(write.comment));
  app.reportIssue(task.id, write.to, new Date(now).toISOString());
}

async function pollRepo(app: App, repo: Repo, now: number, log: Log): Promise<void> {
  await app.issues.ensureLabels(repo.path, LABELS);
  const allowed = await allowedLogins(app, repo);
  const open = await app.issues.openIssues(repo.path);
  const labelled = open.filter((i) => i.labels.includes(ISSUE_LABELS.ready));
  const plans = open.filter((i) => i.labels.includes(ISSUE_LABELS.plan));
  await takeInPlans(app, repo, plans, labelled, allowed, log);
  const tasks = labelled.filter((i) => !i.labels.includes(ISSUE_LABELS.plan));
  await takeIn(app, repo, tasks, allowed, log);
  const listed = new Map(open.map((i) => [i.number, i]));
  for (const link of app.issuesOfRepo(repo.id).filter((l) => !isFinalReport(l.reported))) {
    const followed = isPlanIssueLink(app, link)
      ? followPlan(app, repo, link, listed.get(link.number), now, log)
      : follow(app, repo, link, listed.get(link.number), allowed, now, log);
    await followed.catch((err) => log(`task #${link.task_id}: issue #${link.number} not followed: ${err}`));
  }
  await propose(app, repo, open, new Date(now).toISOString(), log);
}

export async function pollIssues(app: App, log: Log = () => {}, now: number = Date.now()): Promise<void> {
  for (const repo of app.listRepos().filter((r) => r.issues && !r.archived_at)) {
    await pollRepo(app, repo, now, log).catch((err) => log(`${repo.name}: issue poll failed: ${err}`));
  }
}
