// Client for the daemon's local API (daemon/src/api.ts).
export const API_BASE = 'http://127.0.0.1:4317';

export type TaskStatus = 'proposed' | 'queued' | 'running' | 'done' | 'blocked' | 'failed' | 'cancel_requested' | 'cancelled';

export interface Repo {
  id: number;
  name: string;
  path: string;
  base_branch: string;
  test_cmd: string | null;
  allowed_tools: string | null;
  auto_approve: number;
  planned_at: string | null;
  toolchain: string | null;
  setup_cmd: string | null;
  paused_reason: string | null;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  reason: string;
}

export interface DoctorReport {
  repo: string;
  ok: boolean;
  checks: DoctorCheck[];
  paused_reason: string | null;
}

export interface PlannerRun {
  id: number;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  proposed: number;
  note: string | null;
}

export interface RepoDetail extends Repo {
  goals: string;
  goals_path: string;
  planner_runs: PlannerRun[];
}

export interface PlanResult {
  outcome: 'proposed' | 'nothing' | 'failed' | 'rate_limited' | 'no_goals';
  tasks: Task[];
  skipped: string[];
  note: string | null;
}

export interface ServiceStatus {
  installed: boolean;
  loaded: boolean;
  pid: number | null;
  state: string | null;
}

/** A task as returned by the list endpoint: everything except the prompt. */
export interface TaskSummary {
  id: number;
  repo_id: number;
  repo: string | null;
  title: string;
  status: TaskStatus;
  priority: number;
  model: string;
  max_turns: number;
  attempts: number;
  max_attempts: number;
  branch: string | null;
  worktree: string | null;
  blocked_reason: string | null;
  source: 'manual' | 'planner';
  created_at: string;
  updated_at: string;
}

export interface Task extends TaskSummary {
  prompt: string;
}

export interface Run {
  id: number;
  attempt: number;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  num_turns: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tests_passed: number | null;
  result_text: string | null;
  denials: number;
}

export interface TaskDetail extends Task {
  runs: Run[];
}

export interface UsageWindow {
  window: string;
  utilization: number;
  resets_at: number;
  status: string | null;
  observed_at: string;
}

export interface Budget {
  five_hour_max: number;
  five_hour_soft: number;
  weekly_max: number;
  pace_slack: number;
}

export interface Decision {
  allow: boolean;
  max_concurrent: number;
  reason: string | null;
  until: number | null;
  weekly_allowed: number | null;
}

export type NotifyKind = 'done' | 'blocked' | 'failed' | 'hold' | 'proposed';

export interface NotificationRow {
  id: number;
  kind: NotifyKind | 'test';
  title: string;
  body: string;
  task_id: number | null;
  created_at: string;
}

export interface Status {
  paused: boolean;
  rate_limited_until: number | null;
  running: number;
  max_concurrent: number;
  counts: Partial<Record<TaskStatus, number>>;
  usage: UsageWindow[];
  governor: Decision;
  budget: Budget;
  notifications: NotificationRow[];
}

export interface Settings {
  max_concurrent: number;
  budget: Budget;
  notify: { desktop: boolean; events: NotifyKind[]; ntfy_topic: string; ntfy_server: string };
  planner: { enabled: boolean; interval_hours: number; max_tasks: number; model: string };
}

export type LogEntry =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: string }
  | { kind: 'result'; subtype: string; turns: number; cost: number }
  | { kind: 'setup'; passed: boolean; cmd: string; output: string }
  | { kind: 'tests'; passed: boolean; output: string }
  | { kind: 'error'; text: string };

export class ApiError extends Error {}

async function call<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method: init?.method ?? 'GET',
      headers: init?.json ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.json ? JSON.stringify(init.json) : undefined,
    });
  } catch {
    throw new ApiError('offline');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  status: () => call<Status>('/api/status'),
  pause: () => call<Status>('/api/pause', { method: 'POST' }),
  resume: () => call<Status>('/api/resume', { method: 'POST' }),
  settings: () => call<Settings>('/api/settings'),
  updateSettings: (patch: {
    max_concurrent?: number;
    budget?: Partial<Budget>;
    notify?: Partial<Settings['notify']>;
    planner?: Partial<Settings['planner']>;
  }) => call<Settings>('/api/settings', { method: 'POST', json: patch }),
  testNotify: () => call<{ ok: boolean }>('/api/notify/test', { method: 'POST' }),
  repos: () => call<Repo[]>('/api/repos'),
  addRepo: (r: { path: string; name?: string; test?: string; setup?: string }) => call<Repo>('/api/repos', { method: 'POST', json: r }),
  repo: (id: number) => call<RepoDetail>(`/api/repos/${id}`),
  updateRepo: (id: number, patch: { goals?: string; auto_approve?: boolean; test_cmd?: string | null; setup_cmd?: string | null }) =>
    call<RepoDetail>(`/api/repos/${id}`, { method: 'POST', json: patch }),
  plan: (id: number) => call<PlanResult>(`/api/repos/${id}/plan`, { method: 'POST' }),
  doctor: (id: number) => call<DoctorReport>(`/api/repos/${id}/doctor`, { method: 'POST' }),
  resumeRepo: (id: number) => call<Repo>(`/api/repos/${id}/resume`, { method: 'POST' }),
  editTask: (
    id: number,
    patch: { title?: string; prompt?: string; priority?: number; model?: string; max_turns?: number; max_attempts?: number },
  ) => call<TaskDetail>(`/api/tasks/${id}`, { method: 'POST', json: patch }),
  approve: (id: number) => call<TaskDetail>(`/api/tasks/${id}/approve`, { method: 'POST' }),
  reject: (id: number) => call<TaskDetail>(`/api/tasks/${id}/reject`, { method: 'POST' }),
  service: () => call<ServiceStatus>('/api/service'),
  tasks: () => call<TaskSummary[]>('/api/tasks'),
  task: (id: number) => call<TaskDetail>(`/api/tasks/${id}`),
  addTask: (t: { repo: string; prompt: string; title?: string; model?: string; priority?: number; max_turns?: number }) =>
    call<TaskDetail>('/api/tasks', { method: 'POST', json: t }),
  cancel: (id: number) => call<{ result: string }>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  retry: (id: number) => call<TaskDetail>(`/api/tasks/${id}/retry`, { method: 'POST' }),
  logUrl: (id: number, attempt?: number) => `${API_BASE}/api/tasks/${id}/log${attempt ? `?attempt=${attempt}` : ''}`,
};

/** "Tue 14:00" style, for when a hold lifts. */
export function when(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function relTime(unixSeconds: number): string {
  const mins = Math.round((unixSeconds * 1000 - Date.now()) / 60_000);
  if (mins <= 0) return 'now';
  return mins < 90 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`;
}

/** SQLite datetime('now') is UTC without a zone marker. */
export function ago(sqliteUtc: string): string {
  const secs = Math.round((Date.now() - Date.parse(sqliteUtc.replace(' ', 'T') + 'Z')) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function totalTokens(r: Run): number {
  return r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** One label for the daemon's state, shared by the status bar and the tray. */
export function describeState(s: Status | null, offline: boolean): { label: string; cls: string; title: string } {
  if (offline) return { label: 'Daemon offline', cls: 's-failed', title: '' };
  if (!s) return { label: 'Connecting…', cls: 's-queued', title: '' };
  if (s.paused) return { label: 'Paused', cls: 's-blocked', title: 'No new tasks start until you resume' };
  const limited = s.rate_limited_until && s.rate_limited_until * 1000 > Date.now() ? s.rate_limited_until : null;
  if (limited)
    return {
      label: `Rate limited · ${relTime(limited)}`,
      cls: 's-blocked',
      title: 'Claude rejected a request; waiting for the window to reset',
    };
  const g = s.governor;
  if (!g.allow)
    return { label: g.until ? `Holding · until ${when(g.until)}` : 'Holding', cls: 's-blocked', title: `Usage budget: ${g.reason}` };
  if (s.running) return { label: 'Working', cls: 's-running', title: g.reason ?? '' };
  return { label: 'Idle', cls: 's-done', title: g.reason ?? '' };
}
