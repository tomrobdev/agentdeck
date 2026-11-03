// Delivers a notification on the desktop (osascript) and to ntfy. Recording it is the caller's job.
import { execFile } from 'node:child_process';
import type { Notification, NotifySettings } from '../domain/notification.ts';

/** AppleScript string literal. */
const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function desktop(n: Notification): Promise<void> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', `display notification ${q(n.body)} with title "AgentDeck" subtitle ${q(n.title)}`], () => resolve());
  });
}

const NTFY_TAGS: Record<Notification['kind'], string> = {
  done: 'white_check_mark',
  blocked: 'raising_hand',
  failed: 'x',
  hold: 'hourglass',
  paused: 'pause_button',
  proposed: 'memo',
  merged: 'twisted_rightwards_arrows',
  checks_failed: 'rotating_light',
  test: 'bell',
};

export async function ntfy(s: NotifySettings, n: Notification): Promise<void> {
  // JSON publishing keeps titles UTF-8 safe (headers would not be).
  const res = await fetch(s.ntfy_server.replace(/\/$/, ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: s.ntfy_topic,
      title: `AgentDeck: ${n.title}`,
      message: n.body,
      tags: [NTFY_TAGS[n.kind]],
      priority: n.kind === 'blocked' || n.kind === 'failed' ? 4 : 3,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
}
