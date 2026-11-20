import { type SettingsPatch, onOff } from '#application/actions.ts';
import type { NotifyKind } from '#domain/operations/index.ts';

export const OPERATIONS_SETTINGS: Record<string, (value: string, key: string) => SettingsPatch> = {
  notify_desktop: (value, key) => ({ notify: { desktop: onOff(key, value) } }),
  notify_events: (value) => {
    const events = value
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    return { notify: { events: events as NotifyKind[] } };
  },
  ntfy_topic: (value, key) => ({ notify: { [key]: value } }),
  ntfy_server: (value, key) => ({ notify: { [key]: value } }),
  reload_on_change: (value, key) => ({ reload_on_change: onOff(key, value) }),
};
