// A chore the scheduler starts at most once an interval, and never while its last start is still running.
export function periodic(
  everyMs: number,
  what: string,
  chore: (now: number) => Promise<unknown>,
  log: (msg: string) => void,
): (now: number) => void {
  let last = 0;
  let busy = false;
  return (now) => {
    if (busy || now - last < everyMs) return;
    last = now;
    busy = true;
    chore(now)
      .catch((err) => log(`${what} crashed: ${err instanceof Error && err.stack ? err.stack : String(err)}`))
      .finally(() => {
        busy = false;
      });
  };
}
