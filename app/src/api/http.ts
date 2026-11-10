import type { QueryClient } from '@tanstack/vue-query';

export const API_BASE: string = import.meta.env.VITE_AGENTDECK_API ?? 'http://127.0.0.1:4317';

export class ApiError extends Error {}
export class OfflineError extends ApiError {
  constructor() {
    super('offline');
  }
}

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

export function qs(params: Record<string, string | number | null | undefined>): string {
  const set = Object.entries(params).flatMap(([k, v]) => (v === null || v === undefined ? [] : [[k, String(v)]]));
  return set.length ? `?${new URLSearchParams(set)}` : '';
}

const isImmutable = (key: readonly unknown[]) => key[0] === 'at' && key[1] !== null;
export const atCommit = (commit: string | null) => (commit ? Infinity : 0);

export const refreshAll = (queryClient: QueryClient) => queryClient.invalidateQueries({ predicate: (q) => !isImmutable(q.queryKey) });

export const retryQuery = (failures: number, e: unknown) => !isOffline(e) && failures < 2;
