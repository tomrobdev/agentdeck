// Bridges to the Tauri shell. In a plain browser (npm run dev) these are no-ops.
import { invoke } from '@tauri-apps/api/core';
import { ref } from 'vue';
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

/** Call `cb` with each agentdeck:// URL opened from outside, including one that started the app. Returns a stop function. */
export async function onOpenUrl(cb: (url: string) => void): Promise<() => void> {
  if (!isNative) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  // The shell keeps the URL until it is taken, so an event and the startup check never route it twice.
  const take = async () => {
    const url = await invoke<string | null>('take_open_url').catch(() => null);
    if (url) cb(url);
  };
  const stop = await listen<string>('open-url', take);
  await take();
  return stop;
}

/** Whether cmux is installed; false in a plain browser. */
export async function cmuxInstalled(): Promise<boolean> {
  if (!isNative) return false;
  try {
    return await invoke<boolean>('cmux_installed');
  } catch {
    return false;
  }
}

/** Open a terminal from the command template: an argv list, run without a shell. `command` is the text to run in it. */
export async function openTerminal(template: string[], opts: { title: string; cwd: string; command?: string }): Promise<void> {
  if (!isNative) throw new Error('Terminals open from the desktop app only');
  try {
    await invoke('open_terminal', { template, ...opts });
  } catch (e) {
    throw new Error(String(e)); // Tauri rejects with the command's error string
  }
}

/** Open a URL in the system browser; in a plain browser, a new tab. Never navigates the dashboard itself. */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//.test(url)) return;
  if (isNative) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.open(url, '_blank', 'noopener');
}

/** Copy text and say so for a moment: `copied` holds the key of what was copied last. */
export function useCopy() {
  const copied = ref('');
  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // no clipboard access (insecure context or denied)
    }
    copied.value = what;
    setTimeout(() => copied.value === what && (copied.value = ''), 1200);
  }
  return { copied, copy };
}
