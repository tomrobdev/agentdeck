// Tasks under the parent issue or plan branch they belong to: the parent's progress, the order its tasks go in and where they merge.
import type { TaskSummary } from '#daemon/api/contract/work.ts';
import { statusGroup } from '#daemon/domain/work/index.ts';

export interface ParentHead {
  issue: { number: number; url: string } | null;
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

function parentKeys(all: TaskSummary[]): Set<string> {
  return new Set(all.flatMap((t) => (t.issue?.parent ? [issueKey(t.repo_id, t.issue.parent.number)] : [])));
}

function keyOf(t: TaskSummary, parents: Set<string>): string {
  if (t.issue?.parent) return issueKey(t.repo_id, t.issue.parent.number);
  const own = t.issue ? issueKey(t.repo_id, t.issue.number) : null;
  if (own && parents.has(own)) return own;
  if (t.merges_into?.plan) return `branch:${t.repo_id}:${t.merges_into.branch}`;
  return `base:${t.repo_id}:${t.merges_into?.branch ?? ''}`;
}

const isParentTask = (t: TaskSummary, key: string): boolean => !!t.issue && !t.issue.parent && key === issueKey(t.repo_id, t.issue.number);

export function mergePath(tasks: Pick<TaskSummary, 'merges_into'>[]): string {
  const paths = tasks.flatMap(({ merges_into: m }) => {
    if (!m) return [];
    return [m.plan ? `→ ${m.branch} → ${m.plan.base}, one PR together` : `→ ${m.branch}, a PR each`];
  });
  return [...new Set(paths)].join(' · ');
}

export function linkOrder(tasks: TaskSummary[]): TaskSummary[] {
  const left = [...tasks].sort((a, b) => (a.issue?.number ?? a.id) - (b.issue?.number ?? b.id));
  const waiting = new Set<number>(left.map((t) => t.id));
  const out: TaskSummary[] = [];
  while (left.length) {
    const ready = left.findIndex((t) => !t.links.some((l) => waiting.has(l.on)));
    const [next] = left.splice(Math.max(ready, 0), 1);
    waiting.delete(next.id);
    out.push(next);
  }
  return out;
}

const RANK = { parent: 0, branch: 1, base: 2 };
type GroupKind = keyof typeof RANK;
const kindOf = (key: string) => key.split(':')[0] as GroupKind;

function byKey(tasks: TaskSummary[], parents: Set<string>): Map<string, TaskSummary[]> {
  const out = new Map<string, TaskSummary[]>();
  for (const t of tasks) {
    const key = keyOf(t, parents);
    const group = out.get(key);
    if (group) group.push(t);
    else out.set(key, [t]);
  }
  return out;
}

function groupLabel(kind: GroupKind, first: TaskSummary, parent: { title: string } | null | undefined, all: TaskSummary[]): string {
  if (parent) return parent.title;
  if (kind === 'base') return [first.repo, 'no parent issue'].filter(Boolean).join(': ');
  return all.find((t) => t.id === first.merges_into?.plan?.task)?.title ?? first.merges_into?.branch ?? '';
}

function groupOf(key: string, listed: TaskSummary[], inGroup: TaskSummary[], all: TaskSummary[]): ParentGroup {
  const kind = kindOf(key);
  const members = inGroup.filter((t) => !isParentTask(t, key) && statusGroup(t) !== 'cancelled');
  const issue = listed.concat(members).find((t) => t.issue?.parent)?.issue;
  const parent = issue?.parent;
  return {
    key,
    label: groupLabel(kind, listed[0], parent, all),
    tasks: [...listed.filter((t) => isParentTask(t, key)), ...linkOrder(listed.filter((t) => !isParentTask(t, key)))],
    head: {
      issue: issue && parent ? { number: parent.number, url: issue.url.replace(/\d+$/, String(parent.number)) } : null,
      done: members.filter((t) => statusGroup(t) === 'done').length,
      total: kind === 'base' ? 0 : members.length,
      merges: mergePath(members.length ? members : listed),
    },
  };
}

export function parentGroups(shown: TaskSummary[], all: TaskSummary[] = shown): ParentGroup[] {
  const parents = parentKeys(all);
  const members = byKey(all, parents);
  return [...byKey(shown, parents)]
    .sort(([a], [b]) => RANK[kindOf(a)] - RANK[kindOf(b)] || a.localeCompare(b, 'en', { numeric: true }))
    .map(([key, listed]) => groupOf(key, listed, members.get(key) ?? [], all));
}

export function parentGroupOf(task: Pick<TaskSummary, 'id'>, all: TaskSummary[]): ParentGroup | null {
  const self = all.find((t) => t.id === task.id);
  if (!self) return null;
  const parents = parentKeys(all);
  const key = keyOf(self, parents);
  if (kindOf(key) === 'base') return null;
  const tasks = all.filter((t) => keyOf(t, parents) === key);
  const group = groupOf(key, tasks, tasks, all);
  return group.head.total > 0 ? group : null;
}
