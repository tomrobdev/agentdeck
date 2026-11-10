// Why the code on disk must not be loaded, kept current: worked out when a source file changes, and again while it blocks.

export const RECHECK_BLOCKED_MS = 10_000;

export interface ReloadBlock {
  readonly reason: string | null;
  refresh(): Promise<void>;
  recheck(): void;
}

export function reloadBlock(
  compute: () => Promise<string | null>,
  opts: { now?: () => number; onNew?: (reason: string) => void; recheckMs?: number } = {},
): ReloadBlock {
  const now = opts.now ?? Date.now;
  const recheckMs = opts.recheckMs ?? RECHECK_BLOCKED_MS;
  let reason: string | null = null;
  let seq = 0;
  let lastAt = 0;
  const refresh = async () => {
    const mine = ++seq;
    lastAt = now();
    const next = await compute();
    if (mine !== seq) return;
    if (next && next !== reason) opts.onNew?.(next);
    reason = next;
  };
  return {
    get reason() {
      return reason;
    },
    refresh,
    recheck() {
      if (reason && now() - lastAt >= recheckMs) void refresh().catch(() => {});
    },
  };
}
