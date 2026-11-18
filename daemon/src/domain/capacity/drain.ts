// A drain: no queued task that has never run starts, the work in flight finishes, then the daemon or the repo ends paused.
import type { RepoId } from '#domain/shared/index.ts';
import { plural } from '#domain/shared/index.ts';

/** What is draining: the whole daemon, or some repos. */
export interface Draining {
  daemon: boolean;
  repos: RepoId[];
}

export const NOT_DRAINING: Draining = { daemon: false, repos: [] };

/** The work still in flight in a drain's scope, which the drain waits for before it pauses. */
export interface InFlight {
  /** Tasks running, and runs of any kind not yet ended. */
  runs: number;
  /** Queued tasks that have run before: their next attempt starts while draining. */
  retries: number;
  /** Planner runs under way. */
  planner: number;
  /** Status changes whose follow-ups (opening a PR, telling a person) have not run yet. */
  follow_ups: number;
  /** Blocked tasks waiting for their unblock run. */
  unblocks: number;
  /** Done tasks waiting for their review run. */
  reviews: number;
}

export const isDraining = (d: Draining, repo: RepoId): boolean => d.daemon || d.repos.includes(repo);

export const mayStart = (d: Draining, task: { repo_id: RepoId; has_run: boolean }): boolean => task.has_run || !isDraining(d, task.repo_id);

export function inFlightLine(f: InFlight): string | null {
  const parts = [
    f.runs ? plural(f.runs, 'run') : '',
    f.retries ? plural(f.retries, 'retry', 'retries') : '',
    f.planner ? plural(f.planner, 'planner run') : '',
    f.follow_ups ? plural(f.follow_ups, 'follow-up') : '',
    f.unblocks ? plural(f.unblocks, 'unblock run') : '',
    f.reviews ? plural(f.reviews, 'review run') : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export function drainedMessage(scope: string | null): { title: string; body: string } {
  return {
    title: scope ? `Drained ${scope}` : 'AgentDeck drained',
    body: `Nothing is in flight; ${scope ?? 'AgentDeck'} is paused. Run \`agentdeck ${scope ? `repo resume ${scope}` : 'resume'}\` to start work again.`,
  };
}
