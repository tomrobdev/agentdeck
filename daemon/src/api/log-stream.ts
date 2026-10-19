// Server-Sent Events tail of a run's log for the dashboard.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../db/index.ts';
import { parseLogLine } from '../domain/run/log.ts';

const LOG_POLL_MS = 500;

/** Stream a run's log as SSE: everything so far, then new lines until the run ends. */
export function streamLog(
  db: Db,
  req: IncomingMessage,
  res: ServerResponse,
  taskId: number,
  pick: { attempt?: number; run?: number } = {},
): void {
  const runs = db.runsForTask(taskId);
  // By attempt means the work run of that attempt; a resolve run is picked by its id.
  const run = pick.run
    ? runs.find((r) => r.id === pick.run)
    : pick.attempt
      ? runs.find((r) => r.attempt === pick.attempt && r.kind === 'work')
      : runs.at(-1);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  if (!run) {
    res.write('event: end\ndata: {}\n\n');
    return void res.end();
  }

  let offset = 0;
  let partial = '';
  const pump = () => {
    if (existsSync(run.log_path)) {
      const size = statSync(run.log_path).size;
      if (size > offset) {
        const fd = openSync(run.log_path, 'r');
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        offset = size;
        const lines = (partial + buf.toString('utf8')).split('\n');
        partial = lines.pop() ?? '';
        const entries = lines.flatMap(parseLogLine);
        if (entries.length) res.write(`data: ${JSON.stringify(entries)}\n\n`);
      }
    }
    const current = db.runsForTask(taskId).find((r) => r.id === run.id);
    if (current?.ended_at) {
      res.write('event: end\ndata: {}\n\n');
      res.end();
      clearInterval(timer);
    }
  };
  const timer = setInterval(pump, LOG_POLL_MS);
  req.on('close', () => clearInterval(timer));
  pump();
}
