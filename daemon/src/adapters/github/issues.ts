// Adapter for reading a repo's GitHub issues and reporting back on them with gh.
import {
  ISSUE_FIELDS,
  type Issue,
  type IssueComment,
  labelledBy,
  parseIssue,
  parseIssueComments,
  parseIssues,
  parseLabelNames,
} from '#domain/work/index.ts';
import { gh as run } from '#adapters/github/github.ts';

const MAX_BUFFER = 16 * 1024 * 1024;

const gh = (cwd: string, args: string[]): Promise<string> => run(args, { cwd, maxBuffer: MAX_BUFFER });

async function withParentBody(cwd: string, issue: Issue): Promise<Issue> {
  if (!issue.parent || issue.parent.body) return issue;
  const parent = parseIssue(await gh(cwd, ['issue', 'view', String(issue.parent.number), '--json', 'number,title,body']));
  return parent ? { ...issue, parent: { number: parent.number, title: parent.title, body: parent.body } } : issue;
}

export const githubIssues = {
  async whoami(cwd: string): Promise<string> {
    return (await gh(cwd, ['api', 'user', '--jq', '.login'])).trim();
  },

  async ensureLabels(cwd: string, labels: readonly { name: string; description: string; color: string }[]): Promise<void> {
    const have = new Set(parseLabelNames(await gh(cwd, ['label', 'list', '--limit', '500', '--json', 'name'])));
    for (const l of labels.filter((l) => !have.has(l.name)))
      await gh(cwd, ['label', 'create', l.name, '--description', l.description, '--color', l.color]);
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
    const events = await gh(cwd, ['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${number}/timeline`]);
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

  async close(cwd: string, number: number, comment: string): Promise<void> {
    await gh(cwd, ['issue', 'close', String(number), '--reason', 'completed', '--comment', comment]);
  },
};
