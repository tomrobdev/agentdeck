// Why the code on disk must not be loaded, kept current: worked out when a source file changes, and again while it blocks.
// A commit touches no .ts file, so without the re-check a block on uncommitted changes would outlast the commit.

/** While blocked, the block is looked at again no more often than this. */
export const RECHECK_BLOCKED_MS = 10_000;

export interface ReloadBlock {
  /** The current reason, or null. */
  readonly reason: string | null;
  /** Work the reason out now (a source file changed). */
  refresh(): Promise<void>;
  /** While blocked and not looked at for RECHECK_BLOCKED_MS, work it out again in the background. */
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
    // A newer refresh started while this one was working: its answer is the fresher one.
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
