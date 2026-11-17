import type { QueryClient } from '@tanstack/vue-query';
import { invoke } from '@tauri-apps/api/core';
import { ApiError, OfflineError } from './api-error';
import type { ApiErrorBody } from './types';

export const API_BASE: string = import.meta.env.VITE_AGENTDECK_API ?? 'http://127.0.0.1:4317';

async function readToken(): Promise<string | null> {
  try {
    if ('__TAURI_INTERNALS__' in window) return await invoke<string | null>('api_token');
    const res = await fetch('/__agentdeck/token');
    return res.ok ? ((await res.json()) as { token: string | null }).token : null;
  } catch {
    return null;
  }
}

let token: Promise<string | null> | undefined;
const apiToken = (fresh: boolean) => (fresh || !token ? (token = readToken()) : token);

async function send(method: string, path: string, json: unknown, freshToken: boolean): Promise<Response> {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const t = await apiToken(freshToken);
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  try {
    return await fetch(API_BASE + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  } catch {
    throw new OfflineError();
  }
}

async function call<T>(method: string, path: string, json?: unknown): Promise<T> {
  let res = await send(method, path, json, false);
  if (res.status === 401) res = await send(method, path, json, true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const body: Partial<ApiErrorBody> = data;
    throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status, body.code);
  }
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
