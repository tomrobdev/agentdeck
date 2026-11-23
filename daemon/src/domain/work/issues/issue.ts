// A GitHub issue a task came from, the labels the daemon reads and writes on it, and what it last reported there.
import type { RepoId, RunId, TaskId } from '#domain/shared/index.ts';

export const ISSUE_LABELS = {
  ready: 'ready-for-agent',
  info: 'needs-info',
  human: 'ready-for-human',
  running: 'agentdeck:running',
  plan: 'agentdeck:plan',
  parked: 'agentdeck:parked',
  ignore: 'agentdeck:ignore',
} as const;

/** How an issue was closed: done, or set aside. */
export type IssueCloseReason = 'completed' | 'not_planned';

/** An issue another issue is blocked by. */
export interface IssueBlocker {
  number: number;
  open: boolean;
}

/** An issue as the poll reads it from GitHub. */
export interface Issue {
  number: number;
  url: string;
  title: string;
  body: string;
  open: boolean;
  /** Why a closed issue was closed; null while it is open. */
  closed_as: IssueCloseReason | null;
  labels: string[];
  blocked_by: IssueBlocker[];
  /** The issue this one is a sub-issue of: its title and body give the worker context. */
  parent: { number: number; title: string; body: string } | null;
  /** How many sub-issues it has: an issue with any is a map of work, not work itself. */
  sub_issues: number;
}

/** A comment on an issue, by its author's login. */
export interface IssueComment {
  author: string;
  body: string;
  created_at: string;
}

export type TaskIssueReport =
  'proposed' | 'parked' | 'rejected' | 'queued' | 'running' | 'question' | 'stopped' | 'pr_open' | 'merged' | 'cancelled';

export type PlanIssueReport = 'plan_open' | 'plan_pr_open' | 'plan_merged' | 'plan_abandoned';

/** What the daemon last told an issue about its task, so each change is reported once. */
export type IssueReport = TaskIssueReport | PlanIssueReport;

/** A task's link to the issue it came from. */
export interface TaskIssue {
  task_id: TaskId;
  repo_id: RepoId;
  number: number;
  url: string;
  /** The last change reported on the issue; null before the first. */
  reported: IssueReport | null;
  /** When it was reported, so a person's later comments can be told apart. */
  reported_at: string | null;
  /** The verify run whose findings were last put on the issue; null before any. */
  verify_reported: RunId | null;
  /** The issue it is a sub-issue of, as the last poll read it; null when it has none. */
  parent_number: number | null;
  parent_title: string | null;
}

export const ISSUE_MARK = '<!-- agentdeck -->';

export const signed = (body: string): string => `${body}\n\n${ISSUE_MARK}`;

export function issueTextEditError(
  issue: Pick<TaskIssue, 'number' | 'url'> | undefined,
  fields: { title?: string; prompt?: string },
): string | null {
  if (!issue || (fields.title === undefined && fields.prompt === undefined)) return null;
  return `its title and prompt come from issue #${issue.number}: edit the issue (${issue.url}), and the task follows it`;
}

export function issueRepoAddError(repo: { name: string; issues: boolean }): string | null {
  if (!repo.issues) return null;
  return `${repo.name} takes its tasks from GitHub Issues: open an issue and label it ${ISSUE_LABELS.ready} (gh issue create --label ${ISSUE_LABELS.ready})`;
}
