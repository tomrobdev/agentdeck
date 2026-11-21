// The IssueHost port: reading a repo's issues and reporting back on them.
import type { Issue, IssueCloseReason, IssueComment } from '#domain/work/index.ts';

export interface IssueHost {
  whoami(cwd: string): Promise<string>;
  openIssues(cwd: string, label: string): Promise<Issue[]>;
  issue(cwd: string, number: number): Promise<Issue | null>;
  comments(cwd: string, number: number): Promise<IssueComment[]>;
  labelledBy(cwd: string, number: number, label: string): Promise<string | null>;
  comment(cwd: string, number: number, body: string): Promise<void>;
  editLabels(cwd: string, number: number, change: { add: string[]; remove: string[] }): Promise<void>;
  close(cwd: string, number: number, reason: IssueCloseReason, comment: string): Promise<void>;
}
