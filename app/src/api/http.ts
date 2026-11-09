// How the dashboard talks to the daemon's local API (daemon/src/api/server.ts): the request helpers every context file
// (work.ts, runs.ts, landing.ts, repos.ts, operations.ts, insights.ts) builds its calls on, and the query rules they share.
// VITE_AGENTDECK_API points a dev build at another daemon (e.g. one run on a copy of the database).
import type { QueryClient } from '@tanstack/vue-query';

export const API_BASE: string = import.meta.env.VITE_AGENTDECK_API ?? 'http://127.0.0.1:4317';

/** What the daemon refused, with its reason as the message. */
export class ApiError extends Error {}
/** The daemon could not be reached. */
export class OfflineError extends ApiError {
  constructor() {
    super('offline');
  }
}

/** True for the error a call throws when the daemon can't be reached. */
export const isOffline = (e: unknown) => e instanceof OfflineError;

async function call<T>(method: string, path: string, json?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch {
    throw new OfflineError();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`);
  return data as T;
}
export const get = <T>(path: string) => call<T>('GET', path);
export const post = <T>(path: string, json?: unknown) => call<T>('POST', path, json);
export const del = <T>(path: string) => call<T>('DELETE', path);

/** `?a=1&b=2` from the params that are set (null and undefined are left out; '' is sent), or '' when none are. */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const set = Object.entries(params).flatMap(([k, v]) => (v === null || v === undefined ? [] : [[k, String(v)]]));
  return set.length ? `?${new URLSearchParams(set)}` : '';
}

// The dashboard's server data is TanStack Query options, each with its key, beside its call in the context's file:
// components read them with useQuery, and a write that needs a key takes it from the option (`repoQuery(id).queryKey`).

// Git objects at a commit never change, so their keys start with 'at' and the commit (null while it is unknown).
const isImmutable = (key: readonly unknown[]) => key[0] === 'at' && key[1] !== null;
/** The staleTime of a query keyed by a commit: its data is final once the commit is known. */
export const atCommit = (commit: string | null) => (commit ? Infinity : 0);

/** Refetches everything after a write, except what is keyed by a known commit: its data is final. */
export const refreshAll = (queryClient: QueryClient) => queryClient.invalidateQueries({ predicate: (q) => !isImmutable(q.queryKey) });

/** Offline is handled by the offline screen, which keeps polling status: don't retry it here. */
export const retryQuery = (failures: number, e: unknown) => !isOffline(e) && failures < 2;
