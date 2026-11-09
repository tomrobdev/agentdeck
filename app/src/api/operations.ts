// Operations: the daemon's status, its restarts and health, the launchd service, settings and notifications.
import { queryOptions } from '@tanstack/vue-query';
import { get, isOffline, post } from './http.ts';
import type {
  DaemonHealth,
  DaemonState,
  RestartNowResult,
  RestartResult,
  ServiceStatus,
  Settings,
  SettingsPatch,
  Status,
  TestNotifyResult,
} from './types.ts';

export const operationsApi = {
  status: () => get<Status>('/api/status'),
  pause: () => post<Status>('/api/pause'),
  resume: () => post<Status>('/api/resume'),
  /** Exit once nothing is running so launchd starts the daemon on the new code. `waiting` says what it waits for. */
  restartDaemon: () => post<RestartResult>('/api/daemon/restart'),
  /** Restart at once: the running tasks lose their run and are requeued. */
  restartDaemonNow: () => post<RestartNowResult>('/api/daemon/restart-now'),
  daemonState: () => get<DaemonState>('/api/daemon'),
  /** `agentdeck doctor`, the checkout's HEAD, what is running and the last lines of the daemon log. */
  daemonHealth: () => get<DaemonHealth>('/api/daemon/health'),
  service: () => get<ServiceStatus>('/api/service'),
  settings: () => get<Settings>('/api/settings'),
  updateSettings: (patch: SettingsPatch) => post<Settings>('/api/settings', patch),
  testNotify: () => post<TestNotifyResult>('/api/notify/test'),
};

const STATUS_FALLBACK_MS = 30_000;
// While the daemon is down, look again often, so the screen clears soon after it starts.
const OFFLINE_POLL_MS = 3_000;
/**
 * Status as a window keeps it on screen. The change stream refetches it after writes; it also refetches every 30 s, hidden
 * or not, as waits (a governor hold lifting) change with time, not with a write.
 */
export const liveStatusQuery = () =>
  queryOptions({
    queryKey: ['status'] as const,
    queryFn: operationsApi.status,
    refetchInterval: (q) => (isOffline(q.state.error) ? OFFLINE_POLL_MS : STATUS_FALLBACK_MS),
    refetchIntervalInBackground: true,
  });

/** Copied into a form, so a reopened panel starts from the daemon's answer, not a kept one (gcTime 0). */
export const settingsQuery = () => queryOptions({ queryKey: ['settings'] as const, queryFn: operationsApi.settings, gcTime: 0 });
export const serviceQuery = () => queryOptions({ queryKey: ['service'] as const, queryFn: operationsApi.service });
export const daemonQuery = () => queryOptions({ queryKey: ['daemon'] as const, queryFn: operationsApi.daemonState });
export const daemonHealthQuery = () =>
  queryOptions({ queryKey: ['daemon', 'health'] as const, queryFn: operationsApi.daemonHealth, gcTime: 0 });
