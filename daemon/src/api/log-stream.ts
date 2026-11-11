// Server-Sent Events tail of a run's log for the dashboard.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ComposedApp, taskRuns } from '#application/actions.ts';
import type { TaskId } from '#domain/shared/index.ts';
import { parseLogLine } from '#domain/runs/index.ts';
import { pickRun } from '#domain/runs/index.ts';

const LOG_POLL_MS = 500;

export function streamLog(
  db: ComposedApp,
  req: IncomingMessage,
  res: ServerResponse,
  taskId: TaskId,
  pick: { attempt?: number; run?: number } = {},
): void {
  const run = pickRun(taskRuns(db, taskId), pick);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  if (!run) {
    res.write('event: end\ndata: {}\n\n');
    return void res.end();
  }

  let offset = 0;
  let partial = '';
  const pump = () => {
    try {
      tail();
    } catch (err) {
      clearInterval(timer);
      console.error(err);
      if (!res.writableEnded) {
        res.write('event: end\ndata: {}\n\n');
        res.end();
      }
    }
  };
  const tail = () => {
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
    const current = taskRuns(db, taskId).find((r) => r.id === run.id);
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
