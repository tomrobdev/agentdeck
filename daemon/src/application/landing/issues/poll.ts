// The issue poll: for each issue-backed repo, labelled issues become tasks, a person's changes on an issue reach its task, and the issue is told what its task did.
import type { App } from '#application/ports/app.ts';
import type { Repo } from '#domain/repos/index.ts';
import {
  type Issue,
  type TaskIssue,
  ISSUE_LABELS,
  dueIssueWrite,
  isAllowed,
  issueIntake,
  issueMove,
  issueNote,
  labelRefusal,
  shapePrompt,
  signed,
} from '#domain/work/index.ts';
import { addTask, editTask } from '#application/work/tasks.ts';
import { cancelTask, retryTask } from '#application/landing/person-events.ts';

export const ISSUE_POLL_MS = 120_000;

type Log = (msg: string) => void;

const RUNNING_LABEL = { name: ISSUE_LABELS.running, description: 'An AgentDeck run is working on this issue', color: '1d76db' };

const settled = (link: TaskIssue): boolean => link.reported === 'merged' || link.reported === 'cancelled';

async function allowedLogins(app: App, repo: Repo): Promise<string[]> {
  return repo.issues_allow.length ? repo.issues_allow : [await app.issues.whoami(repo.path)];
}

async function takeIn(app: App, repo: Repo, allowed: string[], log: Log): Promise<void> {
  for (const issue of await app.issues.openIssues(repo.path, ISSUE_LABELS.ready)) {
    if (app.taskOfIssue(repo.id, issue.number) !== undefined) continue;
    await takeInOne(app, repo, issue, allowed, log).catch((err) => log(`${repo.name} issue #${issue.number}: not taken in: ${err}`));
  }
}

async function takeInOne(app: App, repo: Repo, issue: Issue, allowed: string[], log: Log): Promise<void> {
  const by = await app.issues.labelledBy(repo.path, issue.number, ISSUE_LABELS.ready);
  const intake = issueIntake(issue, { labelledBy: by, allowed, taskOf: (n) => app.taskOfIssue(repo.id, n) });
  if (intake.kind === 'wait') return;
  if (intake.kind === 'refuse') {
    await app.issues.editLabels(repo.path, issue.number, { add: [], remove: [ISSUE_LABELS.ready] });
    await app.issues.comment(repo.path, issue.number, signed(intake.comment));
    log(`${repo.name} issue #${issue.number}: label from ${by ?? 'nobody'} taken off`);
    return;
  }
  const task = await addTask(
    app,
    { repo: repo.name, title: intake.title, prompt: intake.prompt, builds_on: intake.builds_on },
    { source: 'issue', issue: { number: issue.number, url: issue.url } },
  );
  log(`${repo.name} issue #${issue.number}: queued as task #${task.id}`);
}

async function follow(app: App, repo: Repo, link: TaskIssue, allowed: string[], now: number, log: Log): Promise<void> {
  const before = app.getTask(link.task_id);
  const issue = before && (await app.issues.issue(repo.path, link.number));
  if (!before || !issue) return;
  const move = issueMove(before, issue, link);
  if (move.kind === 'cancel') {
    cancelTask(app, before.id);
    log(`task #${before.id}: cancelled, ${move.reason}`);
  } else if (move.kind === 'edit') await editTask(app, before.id, { title: move.title, prompt: move.prompt });
  else if (move.kind === 'retry') {
    const by = await app.issues.labelledBy(repo.path, link.number, ISSUE_LABELS.ready);
    if (!isAllowed(allowed, by)) {
      await app.issues.editLabels(repo.path, link.number, { add: [], remove: [ISSUE_LABELS.ready] });
      await app.issues.comment(repo.path, link.number, signed(labelRefusal(allowed, by)));
      log(`task #${before.id}: not retried, issue #${link.number} labelled by ${by ?? 'nobody'}`);
      return;
    }
    const note = issueNote(await app.issues.comments(repo.path, link.number), link.reported_at, allowed);
    retryTask(app, before.id, { note });
    log(`task #${before.id}: retried from issue #${link.number}`);
  }
  const task = app.getTask(link.task_id);
  const write = task && dueIssueWrite(task, link, { opens_prs: repo.pr_mode !== 'off', warnings: shapePrompt(task.prompt).warnings });
  if (!task || !write) return;
  const add = write.add.filter((l) => !issue.labels.includes(l));
  const remove = write.remove.filter((l) => issue.labels.includes(l));
  await app.issues.editLabels(repo.path, link.number, { add, remove });
  if (write.close && issue.open) await app.issues.close(repo.path, link.number, 'completed', signed(write.comment));
  else await app.issues.comment(repo.path, link.number, signed(write.comment));
  app.reportIssue(task.id, write.to, new Date(now).toISOString());
}

async function pollRepo(app: App, repo: Repo, now: number, log: Log): Promise<void> {
  await app.codeHost.ensureLabel(repo.path, RUNNING_LABEL);
  const allowed = await allowedLogins(app, repo);
  await takeIn(app, repo, allowed, log);
  for (const link of app.issuesOfRepo(repo.id).filter((l) => !settled(l))) {
    await follow(app, repo, link, allowed, now, log).catch((err) =>
      log(`task #${link.task_id}: issue #${link.number} not followed: ${err}`),
    );
  }
}

export async function pollIssues(app: App, log: Log = () => {}, now: number = Date.now()): Promise<void> {
  for (const repo of app.listRepos().filter((r) => r.issues && !r.archived_at)) {
    await pollRepo(app, repo, now, log).catch((err) => log(`${repo.name}: issue poll failed: ${err}`));
  }
}
