// Bridges to the Tauri shell. In a plain browser (npm run dev) these are no-ops.
import { invoke } from '@tauri-apps/api/core';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';

export const isNative = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function launchAtLogin(): Promise<boolean | null> {
  return isNative ? isEnabled() : null;
}

export async function setLaunchAtLogin(on: boolean): Promise<void> {
  if (isNative) await (on ? enable() : disable());
}

let lastTray = '';
/** Mirror the daemon's state in the tray menu and tooltip. */
export function setTrayStatus(status: string): void {
  if (!isNative || status === lastTray) return;
  lastTray = status;
  invoke('set_tray_status', { status }).catch(() => {});
}

/** Open a URL in the system browser; in a plain browser, a new tab. Never navigates the dashboard itself. */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//.test(url)) return;
  if (isNative) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.open(url, '_blank', 'noopener');
}
