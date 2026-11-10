// The colours a chip can wear. Each is a theme colour variable (styles/themes.css) of the same name; `muted` is the default.
export const TONES = ['muted', 'accent', 'running', 'done', 'blocked', 'failed', 'merged', 'queued', 'cancelled'] as const;
export type Tone = (typeof TONES)[number];

const STATUS_TONE: Record<string, Tone> = {
  proposed: 'accent',
  queued: 'queued',
  interrupted: 'queued',
  running: 'running',
  cancel_requested: 'running',
  done: 'done',
  merged: 'merged',
  blocked: 'blocked',
  failed: 'failed',
  checks_failed: 'failed',
  cancelled: 'cancelled',
};

export const statusTone = (status: string): Tone => STATUS_TONE[status] ?? 'muted';
