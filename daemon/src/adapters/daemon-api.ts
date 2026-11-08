// Asks a running daemon about itself over its HTTP API. Null when nothing (or nothing that speaks JSON) answers.
import type { DaemonState } from '../domain/operations/index.ts';

export async function fetchDaemonState(port: number, timeoutMs = 3000): Promise<DaemonState | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/daemon`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<DaemonState>;
    return typeof body.pid === 'number' && typeof body.started_at === 'string' && body.reload ? (body as DaemonState) : null;
  } catch {
    return null;
  }
}
