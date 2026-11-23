// Tasks under the parent issue or plan branch they belong to: the parent's progress, the order its tasks go in and where they merge.
import type { MergesInto, TaskSummary } from '#daemon/api/contract/work.ts';
import { statusGroup } from '#daemon/domain/work/index.ts';

export interface ParentHead {
  number: number | null;
  url: string | null;
  done: number;
  total: number;
  merges: string;
}

export interface ParentGroup {
  key: string;
  label: string;
  tasks: TaskSummary[];
  head: ParentHead;
}

const issueKey = (repo: number, number: number) => `parent:${repo}:${number}`;

const livePlan = (m: MergesInto | null | undefined) => (m?.plan && m.plan.status !== 'abandoned' ? m.plan : null);

function parentKeys(all: TaskSummary[]): Set<string> {
  return new Set(all.flatMap((t) => (t.issue?.parent ? [issueKey(t.repo_id, t.issue.parent.number)] : [])));
}

function keyOf(t: TaskSummary, parents: Set<string>): string {
  if (t.issue?.parent) return issueKey(t.repo_id, t.issue.parent.number);
  const own = t.issue ? issueKey(t.repo_id, t.issue.number) : null;
  if (own && parents.has(own)) return own;
  if (livePlan(t.merges_into)) return `branch:${t.repo_id}:${t.merges_into?.branch}`;
  return `base:${t.repo_id}:${t.merges_into?.branch ?? ''}`;
}

const isParentTask = (t: TaskSummary, key: string): boolean => !!t.issue && !t.issue.parent && key === issueKey(t.repo_id, t.issue.number);

export function mergePath(tasks: Pick<TaskSummary, 'merges_into'>[]): string {
  const paths = tasks.flatMap(({ merges_into: m }) => {
    if (!m) return [];
    const plan = livePlan(m);
    return [plan ? `→ ${m.branch} → ${plan.base}, one PR together` : `→ ${m.branch}, a PR each`];
  });
  return [...new Set(paths)].join(' · ');
}

export function linkOrder(tasks: TaskSummary[]): TaskSummary[] {
  const left = [...tasks].sort((a, b) => (a.issue?.number ?? a.id) - (b.issue?.number ?? b.id));
  const out: TaskSummary[] = [];
  while (left.length) {
    const ready = left.findIndex((t) => !t.links.some((l) => left.some((o) => o.id === l.on)));
    out.push(...left.splice(Math.max(ready, 0), 1));
  }
  return out;
}

export function parentGroups(shown: TaskSummary[], all: TaskSummary[] = shown): ParentGroup[] {
  const parents = parentKeys(all);
  const rank = (key: string) => ['parent', 'branch', 'base'].indexOf(key.split(':')[0]);
  const keys = [...new Set(shown.map((t) => keyOf(t, parents)))].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true }),
  );
  return keys.map((key) => {
    const members = all.filter((t) => keyOf(t, parents) === key && !isParentTask(t, key) && statusGroup(t) !== 'cancelled');
    const listed = shown.filter((t) => keyOf(t, parents) === key);
    const first = listed[0];
    const issue = listed.concat(members).find((t) => t.issue?.parent && rank(key) === 0)?.issue;
    const branch = first.merges_into?.branch;
    const label = issue?.parent
      ? issue.parent.title
      : rank(key) === 1
        ? (all.find((t) => t.id === first.merges_into?.plan?.task)?.title ?? branch ?? '')
        : [first.repo, 'no parent issue'].filter(Boolean).join(': ');
    return {
      key,
      label,
      tasks: [...listed.filter((t) => isParentTask(t, key)), ...linkOrder(listed.filter((t) => !isParentTask(t, key)))],
      head: {
        number: issue?.parent?.number ?? null,
        url: issue?.parent ? issue.url.replace(/\d+$/, String(issue.parent.number)) : null,
        done: members.filter((t) => statusGroup(t) === 'done').length,
        total: rank(key) === 2 ? 0 : members.length,
        merges: mergePath(members.length ? members : listed),
      },
    };
  });
}

export function parentGroupOf(task: Pick<TaskSummary, 'id'>, all: TaskSummary[]): ParentGroup | null {
  const group = parentGroups(all).find((g) => g.tasks.some((t) => t.id === task.id));
  return group && group.head.total > 0 ? group : null;
}
