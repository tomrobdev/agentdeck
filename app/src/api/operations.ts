// Operations: the daemon's status, its restarts and health, the launchd service, settings and notifications.
import { queryOptions } from '@tanstack/vue-query';
import { isOffline } from '#api/api-error.ts';
import { get, post } from '#api/http.ts';
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
} from '#api/types.ts';

export const operationsApi = {
  status: () => get<Status>('/api/status'),
  pause: () => post<Status>('/api/pause'),
  resume: () => post<Status>('/api/resume'),
  drain: () => post<Status>('/api/drain'),
  restartDaemon: () => post<RestartResult>('/api/daemon/restart'),
  restartDaemonNow: () => post<RestartNowResult>('/api/daemon/restart-now'),
  daemonState: () => get<DaemonState>('/api/daemon'),
  daemonHealth: () => get<DaemonHealth>('/api/daemon/health'),
  service: () => get<ServiceStatus>('/api/service'),
  settings: () => get<Settings>('/api/settings'),
  updateSettings: (patch: SettingsPatch) => post<Settings>('/api/settings', patch),
  testNotify: () => post<TestNotifyResult>('/api/notify/test'),
};

const STATUS_FALLBACK_MS = 30_000;
const OFFLINE_POLL_MS = 3_000;
export const liveStatusQuery = () =>
  queryOptions({
    queryKey: ['status'] as const,
    queryFn: operationsApi.status,
    refetchInterval: (q) => (isOffline(q.state.error) ? OFFLINE_POLL_MS : STATUS_FALLBACK_MS),
    refetchIntervalInBackground: true,
  });

export const settingsQuery = () => queryOptions({ queryKey: ['settings'] as const, queryFn: operationsApi.settings, gcTime: 0 });
export const serviceQuery = () => queryOptions({ queryKey: ['service'] as const, queryFn: operationsApi.service });
export const daemonQuery = () => queryOptions({ queryKey: ['daemon'] as const, queryFn: operationsApi.daemonState });
export const daemonHealthQuery = () =>
  queryOptions({ queryKey: ['daemon', 'health'] as const, queryFn: operationsApi.daemonHealth, gcTime: 0 });
