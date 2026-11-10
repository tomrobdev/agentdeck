// How far a proposed or queued task's prompt is behind its base, and which open tasks touch the same files.
import type { TaskId } from '../../shared/index.ts';
import { plural, sqliteUtc } from '../../shared/index.ts';
import type { PullRequest } from '../../landing/index.ts';
import type { TaskStatus } from '../lifecycle/lifecycle.ts';

export const CHECKED_STATUSES: readonly TaskStatus[] = ['proposed', 'queued'];

/** A commit on the base since a task was added, with the paths it changed. `at` is its author date, UTC `YYYY-MM-DD HH:MM:SS`. */
export interface BaseCommit {
  sha: string;
  subject: string;
  at: string;
  paths: string[];
}

/** A named path the base changed since the task was added, and the commits that changed it, newest first. */
export interface StalePath {
  path: string;
  commits: { sha: string; subject: string; at: string }[];
}

/** How far the base (`ref`, at commit `base`) moved since the task was added. */
export interface Staleness {
  ref: string;
  base: string;
  commits: number;
  changed: StalePath[];
}

/** Another open task in the repo that touches the same files, the paths they share, and whether a link joins them. */
export interface Overlap {
  id: TaskId;
  title: string;
  status: TaskStatus;
  paths: string[];
  linked: boolean;
}

/** What the dashboard and `agentdeck show` say about a proposal before it is approved. */
export interface ProposalCheck {
  /** Null when git can't say (no base, an unreadable repo). */
  staleness: Staleness | null;
  /** promptWarnings' lines: named paths that aren't on the base. */
  notes: string[];
  overlaps: Overlap[];
}

export const emptyProposalCheck = (): ProposalCheck => ({ staleness: null, notes: [], overlaps: [] });

const covers = (named: string, path: string): boolean => (named.endsWith('/') ? path.startsWith(named) : named === path);

export function staleness(named: readonly string[], commits: readonly BaseCommit[]): { commits: number; changed: StalePath[] } {
  const changed = named.flatMap((path) => {
    const by = commits.filter((c) => c.paths.some((p) => covers(path, p))).map(({ sha, subject, at }) => ({ sha, subject, at }));
    return by.length ? [{ path, commits: by }] : [];
  });
  return { commits: commits.length, changed };
}

export function meetAt(a: string, b: string): string | null {
  if (a === b) return a;
  if (a.endsWith('/') && b.startsWith(a)) return b;
  if (b.endsWith('/') && a.startsWith(b)) return a;
  return null;
}

export const mayOverlap = (t: { status: TaskStatus; pr: Pick<PullRequest, 'state'> | null }): boolean =>
  t.status === 'proposed' || t.status === 'queued' || t.status === 'running' || (t.status === 'done' && t.pr?.state === 'open');

/** Another task, with the paths it names or changed and whether a link (either way) joins it to the task checked. */
export interface OverlapCandidate {
  id: TaskId;
  title: string;
  status: TaskStatus;
  paths: readonly string[];
  linked: boolean;
}

export function overlaps(own: readonly string[], candidates: readonly OverlapCandidate[]): Overlap[] {
  const sorted = [...candidates].sort((a, b) => a.id - b.id);
  return sorted.flatMap((c) => {
    const shared = new Set<string>();
    for (const a of own)
      for (const b of c.paths) {
        const at = meetAt(a, b);
        if (at) shared.add(at);
      }
    return shared.size ? [{ id: c.id, title: c.title, status: c.status, paths: [...shared].sort(), linked: c.linked }] : [];
  });
}

export function proposalCheckLine(check: ProposalCheck): string | null {
  const parts: string[] = [];
  const s = check.staleness;
  if (s?.commits) parts.push(`written ${plural(s.commits, 'commit')} ago`);
  if (s?.changed.length) parts.push(`${plural(s.changed.length, 'named file')} changed`);
  const unlinked = check.overlaps.filter((o) => !o.linked);
  if (unlinked.length) parts.push(`touches the same files as ${unlinked.map((o) => `#${o.id}`).join(', ')}`);
  return parts.length ? parts.join(' · ') : null;
}

export const BASE_LOG_FORMAT = '%x1e%H%x1f%s%x1f%aI';

export function parseBaseLog(out: string): BaseCommit[] {
  return out
    .split('\x1e')
    .filter((r) => r.trim())
    .map((r) => {
      const [head, ...rest] = r.split('\0');
      const [sha, subject, iso] = head.split('\x1f');
      const paths = rest.map((p) => p.replace(/^\n/, '')).filter(Boolean);
      return { sha, subject, at: sqliteUtc(iso), paths };
    });
}
