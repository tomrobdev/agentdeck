// Adapter for reading a repo's GitHub issues and reporting back on them with gh.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ISSUE_FIELDS,
  type Issue,
  type IssueCloseReason,
  type IssueComment,
  labelledBy,
  parseIssue,
  parseIssueComments,
  parseIssues,
} from '#domain/work/index.ts';
import { failure } from '#adapters/github/github.ts';

const exec = promisify(execFile);
const GH_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 16 * 1024 * 1024;

async function gh(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    throw failure(err, 'gh', GH_TIMEOUT_MS);
  }
}

async function withParentBody(cwd: string, issue: Issue): Promise<Issue> {
  if (!issue.parent || issue.parent.body) return issue;
  const parent = parseIssue(await gh(cwd, ['issue', 'view', String(issue.parent.number), '--json', 'number,title,body']));
  return parent ? { ...issue, parent: { number: parent.number, title: parent.title, body: parent.body } } : issue;
}

export const githubIssues = {
  async whoami(cwd: string): Promise<string> {
    return (await gh(cwd, ['api', 'user', '--jq', '.login'])).trim();
  },

  async openIssues(cwd: string, label: string): Promise<Issue[]> {
    const issues = parseIssues(
      await gh(cwd, ['issue', 'list', '--state', 'open', '--label', label, '--limit', '200', '--json', ISSUE_FIELDS]),
    );
    return Promise.all(issues.map((issue) => withParentBody(cwd, issue)));
  },

  async issue(cwd: string, number: number): Promise<Issue | null> {
    const issue = parseIssue(await gh(cwd, ['issue', 'view', String(number), '--json', ISSUE_FIELDS]));
    return issue && withParentBody(cwd, issue);
  },

  async comments(cwd: string, number: number): Promise<IssueComment[]> {
    return parseIssueComments(await gh(cwd, ['issue', 'view', String(number), '--json', 'comments']));
  },

  async labelledBy(cwd: string, number: number, label: string): Promise<string | null> {
    const events = await gh(cwd, ['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${number}/timeline`, '--jq', 'add']);
    return labelledBy(events, label);
  },

  async comment(cwd: string, number: number, body: string): Promise<void> {
    await gh(cwd, ['issue', 'comment', String(number), '--body', body]);
  },

  async editLabels(cwd: string, number: number, change: { add: string[]; remove: string[] }): Promise<void> {
    if (!change.add.length && !change.remove.length) return;
    const args = [
      ...(change.add.length ? ['--add-label', change.add.join(',')] : []),
      ...(change.remove.length ? ['--remove-label', change.remove.join(',')] : []),
    ];
    await gh(cwd, ['issue', 'edit', String(number), ...args]);
  },

  async close(cwd: string, number: number, reason: IssueCloseReason, comment: string): Promise<void> {
    await gh(cwd, [
      'issue',
      'close',
      String(number),
      '--reason',
      reason === 'not_planned' ? 'not planned' : 'completed',
      '--comment',
      comment,
    ]);
  },
};
