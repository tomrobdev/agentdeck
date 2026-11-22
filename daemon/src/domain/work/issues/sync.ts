// What an issue-backed repo's poll decides: which issues become tasks or proposals, what a person's change on an issue does to its task, and what the issue is told back.
import type { TaskId } from '#domain/shared/index.ts';
import type { Task } from '#domain/work/task/task.ts';
import { shapePrompt } from '#domain/work/task/prompt.ts';
import {
  ISSUE_LABELS,
  ISSUE_MARK,
  type Issue,
  type IssueComment,
  type IssueReport,
  type TaskIssue,
  type TaskIssueReport,
} from '#domain/work/issues/issue.ts';

/** What to do with a labelled issue that has no task yet. */
type Intake =
  | { kind: 'add'; title: string; prompt: string; builds_on: TaskId[]; plan_task: TaskId | null }
  | { kind: 'wait'; reason: string }
  | { kind: 'refuse'; comment: string };

function issuePrompt(issue: Pick<Issue, 'body' | 'parent'>): string {
  const body = issue.body.trim();
  if (!issue.parent) return body;
  const parent = issue.parent.body.trim();
  return `${body}\n\n## Context\nThis is part of #${issue.parent.number}, ${issue.parent.title}.${parent ? `\n\n${parent}` : ''}`;
}

export const isAllowed = (allowed: readonly string[], login: string | null): boolean =>
  login !== null && allowed.some((a) => a.toLowerCase() === login.toLowerCase());

export function labelRefusal(allowed: readonly string[], by: string | null, label: string = ISSUE_LABELS.ready): string {
  return `AgentDeck takes an issue only when ${allowed.join(' or ') || 'a listed login'} adds the ${label} label${by ? `, not ${by}` : ''}, so the label is taken off.`;
}

interface IntakeLookups {
  taskOf: (number: number) => TaskId | undefined;
  planOf?: (number: number) => TaskId | undefined;
}

export function issueIntake(issue: Issue, ctx: IntakeLookups & { labelledBy: string | null; allowed: readonly string[] }): Intake {
  if (!isAllowed(ctx.allowed, ctx.labelledBy)) return { kind: 'refuse', comment: labelRefusal(ctx.allowed, ctx.labelledBy) };
  return intakeOf(issue, ctx);
}

const KEPT_OUT: readonly string[] = [ISSUE_LABELS.human, ISSUE_LABELS.ignore, ISSUE_LABELS.plan];

const keptOutOfProposals = (issue: Pick<Issue, 'labels' | 'sub_issues'>): boolean =>
  issue.sub_issues > 0 || issue.labels.some((l) => KEPT_OUT.includes(l));

export function proposalIntake(issue: Issue, ctx: IntakeLookups): Intake | null {
  if (!issue.open || issue.labels.includes(ISSUE_LABELS.ready) || keptOutOfProposals(issue) || !issue.body.trim()) return null;
  return intakeOf(issue, ctx);
}

function intakeOf(issue: Issue, ctx: IntakeLookups): Intake {
  if (!issue.body.trim())
    return {
      kind: 'refuse',
      comment: `This issue has no body for the task's prompt, so the label is taken off. Write its ## Current problem and ## Expected outcome, then put the ${ISSUE_LABELS.ready} label back.`,
    };
  const open = issue.blocked_by.filter((b) => b.open);
  const untracked = open.filter((b) => ctx.taskOf(b.number) === undefined);
  if (untracked.length)
    return { kind: 'wait', reason: `blocked by ${untracked.map((b) => `#${b.number}`).join(', ')}, which has no task yet` };
  return {
    kind: 'add',
    title: issue.title.trim() || `Issue #${issue.number}`,
    prompt: issuePrompt(issue),
    builds_on: open.flatMap((b) => ctx.taskOf(b.number) ?? []),
    plan_task: (issue.parent && ctx.planOf?.(issue.parent.number)) ?? null,
  };
}

/** What a person's change on an issue does to its task. A drop cancels a proposal and tells the issue nothing. */
type IssueMove =
  | { kind: 'none' }
  | { kind: 'cancel'; reason: string }
  | { kind: 'drop'; reason: string }
  | { kind: 'edit'; title: string; prompt: string }
  | { kind: 'retry' }
  | { kind: 'approve' }
  | { kind: 'refuse'; comment: string };

function followText(task: Pick<Task, 'title' | 'prompt'>, issue: Issue): IssueMove {
  const title = issue.title.trim() || task.title;
  const prompt = shapePrompt(issuePrompt(issue)).prompt;
  return title !== task.title || prompt !== task.prompt ? { kind: 'edit', title, prompt } : { kind: 'none' };
}

function proposalMove(task: Pick<Task, 'id' | 'status' | 'title' | 'prompt'>, issue: Issue): IssueMove {
  if (!issue.open) return { kind: 'drop', reason: 'its issue was closed' };
  if (keptOutOfProposals(issue)) return { kind: 'drop', reason: 'its issue is no longer for AgentDeck' };
  if (issue.labels.includes(ISSUE_LABELS.ready))
    return task.status === 'proposed'
      ? { kind: 'approve' }
      : {
          kind: 'refuse',
          comment: `Task #${task.id} is parked in AgentDeck, so the ${ISSUE_LABELS.ready} label is taken off. Lift it there first, then approve it.`,
        };
  return followText(task, issue);
}

const ANSWERED: readonly (IssueReport | null)[] = ['question', 'stopped'];

export function issueMove(
  task: Pick<Task, 'id' | 'status' | 'title' | 'prompt'>,
  issue: Issue,
  link: Pick<TaskIssue, 'reported'>,
): IssueMove {
  if (task.status === 'proposed' || task.status === 'parked') return proposalMove(task, issue);
  const settled = task.status === 'done' || task.status === 'cancelled';
  if (!settled && issue.closed_as === 'not_planned') return { kind: 'cancel', reason: 'its issue was closed as not planned' };
  const ready = issue.open && issue.labels.includes(ISSUE_LABELS.ready);
  if (task.status === 'queued') {
    if (!issue.open) return { kind: 'cancel', reason: 'its issue was closed' };
    const personRemoved = link.reported === null || link.reported === 'queued';
    if (!ready && personRemoved) return { kind: 'cancel', reason: `its issue lost the ${ISSUE_LABELS.ready} label` };
    return followText(task, issue);
  }
  if ((task.status === 'blocked' || task.status === 'failed') && ready && ANSWERED.includes(link.reported)) return { kind: 'retry' };
  return { kind: 'none' };
}

export function issueNote(comments: readonly IssueComment[], since: string | null, allowed: readonly string[]): string {
  const said = comments
    .filter((c) => !c.body.includes(ISSUE_MARK) && isAllowed(allowed, c.author) && (since === null || c.created_at > since))
    .map((c) => c.body.trim());
  return said.filter(Boolean).join('\n\n') || `The issue was labelled ${ISSUE_LABELS.ready} again with no new comment.`;
}

function issueReportFor(task: Task, opensPrs: boolean, last: IssueReport | null): TaskIssueReport | null {
  switch (task.status) {
    case 'proposed':
      return 'proposed';
    case 'parked':
      return 'parked';
    case 'queued':
      return 'queued';
    case 'running':
    case 'cancel_requested':
      return 'running';
    case 'blocked':
      return task.question ? 'question' : 'stopped';
    case 'failed':
      return 'stopped';
    case 'done':
      if (!task.pr) return opensPrs ? null : 'merged';
      return task.pr.state === 'open' ? 'pr_open' : task.pr.state === 'merged' ? 'merged' : null;
    case 'cancelled':
      return last === 'proposed' || last === 'parked' ? 'rejected' : 'cancelled';
    default: {
      const never: never = task;
      return never;
    }
  }
}

/** What to write on the issue when its task's report changes. */
interface IssueWrite {
  add: string[];
  remove: string[];
  /** Empty when the change is only recorded, not told. */
  comment: string;
  close: boolean;
  close_as?: 'completed' | 'not_planned';
}

const prUrl = (task: Task): string | null => (task.pr && 'url' in task.pr ? task.pr.url : null);

function issueWrite(to: TaskIssueReport, task: Task, last: IssueReport | null): IssueWrite {
  const { ready, info, running, parked } = ISSUE_LABELS;
  const again = `Put the ${ready} label back to try again.`;
  switch (to) {
    case 'proposed':
      return {
        add: [],
        remove: [parked],
        comment: last === 'parked' ? `Task #${task.id} was lifted in AgentDeck and is a proposal again.` : '',
        close: false,
      };
    case 'parked': {
      const reason = task.status === 'parked' && task.park_reason ? `: ${task.park_reason}` : '.';
      return {
        add: [parked],
        remove: [ready],
        comment: `Task #${task.id} was parked in AgentDeck${reason}\n\nLifting it there makes it a proposal again.`,
        close: false,
      };
    }
    case 'rejected':
      return {
        add: [],
        remove: [parked, ready],
        comment: `Task #${task.id} was rejected in AgentDeck.`,
        close: true,
        close_as: 'not_planned',
      };
    case 'queued': {
      const { warnings } = shapePrompt(task.prompt);
      const notes = warnings.length ? `\n\nThe body should follow AgentDeck's prompt headings: ${warnings.join('; ')}.` : '';
      const how = last === 'proposed' ? `Approved in AgentDeck and queued as task #${task.id}.` : `Queued as AgentDeck task #${task.id}.`;
      return { add: [ready], remove: [running, info], comment: `${how}${notes}`, close: false };
    }
    case 'running':
      return {
        add: [running],
        remove: [],
        comment: `Task #${task.id} started (attempt ${task.attempts} of ${task.max_attempts}).`,
        close: false,
      };
    case 'question': {
      const q = task.status === 'blocked' ? task.question : null;
      const options = q?.options.length ? `\n\n${q.options.map((o) => `- ${o}`).join('\n')}` : '';
      return {
        add: [info],
        remove: [ready, running],
        comment: `Task #${task.id} needs an answer:\n\n> ${q?.question ?? 'see the task'}${options}\n\nReply here, then put the ${ready} label back: your reply goes to the retry as its note.`,
        close: false,
      };
    }
    case 'stopped': {
      const reason = 'stop_reason' in task && task.stop_reason ? `: ${task.stop_reason}` : '.';
      return {
        add: [],
        remove: [ready, running],
        comment: `Task #${task.id} ${task.status === 'failed' ? 'failed' : 'is blocked'}${reason}\n\n${again}`,
        close: false,
      };
    }
    case 'pr_open':
      return { add: [], remove: [running], comment: `Task #${task.id} opened ${prUrl(task) ?? 'its pull request'}.`, close: false };
    case 'merged': {
      const url = prUrl(task);
      return { add: [], remove: [ready, running], comment: url ? `Merged in ${url}.` : `Task #${task.id} is done.`, close: true };
    }
    case 'cancelled':
      return { add: [], remove: [ready, running], comment: `Task #${task.id} was cancelled.`, close: false };
    default: {
      const never: never = to;
      return never;
    }
  }
}

/** What to write on an issue now: only the labels it lacks or still has, and a close only while it is open. */
export type DueIssueWrite = IssueWrite & { to: TaskIssueReport };

const FINAL_REPORTS: readonly (IssueReport | null)[] = ['merged', 'cancelled', 'rejected', 'plan_merged', 'plan_abandoned'];

export const isFinalReport = (r: IssueReport | null): boolean => FINAL_REPORTS.includes(r);

export function dueIssueWrite(
  task: Task,
  link: Pick<TaskIssue, 'reported'>,
  issue: Pick<Issue, 'labels' | 'open'>,
  opensPrs: boolean,
): DueIssueWrite | null {
  const to = issueReportFor(task, opensPrs, link.reported);
  if (to === null || to === link.reported) return null;
  const write = issueWrite(to, task, link.reported);
  return {
    to,
    add: write.add.filter((l) => !issue.labels.includes(l)),
    remove: write.remove.filter((l) => issue.labels.includes(l)),
    comment: write.comment,
    close: write.close && issue.open,
    ...(write.close_as ? { close_as: write.close_as } : {}),
  };
}
