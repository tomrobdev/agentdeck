// Server-Sent Events tail of a run's log for the dashboard, resumable by byte offset.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ComposedApp, taskRuns } from '../application/actions.ts';
import type { TaskId } from '../domain/shared/index.ts';
import { parseLogLine } from '../domain/runs/index.ts';
import { pickRun } from '../domain/runs/index.ts';

import { errorText } from './http.ts';

const LOG_POLL_MS = 500;
const LOG_PING_MS = 25_000;

function startOffset(req: IncomingMessage, from: string | null): number {
  const header = req.headers['last-event-id'];
  const value = Number(typeof header === 'string' && header !== '' ? header : from);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function streamLog(
  db: ComposedApp,
  req: IncomingMessage,
  res: ServerResponse,
  taskId: TaskId,
  pick: { attempt?: number; run?: number; from?: string | null } = {},
  pingMs = LOG_PING_MS,
  log: (line: string) => void = () => undefined,
): void {
  const run = pickRun(taskRuns(db, taskId), pick);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  if (!run) {
    res.write('event: end\ndata: {}\n\n');
    return void res.end();
  }

  let offset = startOffset(req, pick.from ?? null);
  const stop = () => {
    clearInterval(timer);
    clearInterval(ping);
  };
  const pump = () => {
    try {
      tail();
    } catch (err) {
      stop();
      log(`api GET ${req.url?.split('?')[0]} log stream failed: ${errorText(err)}`);
      if (!res.writableEnded) {
        res.write('event: end\ndata: {}\n\n');
        res.end();
      }
    }
  };
  const tail = () => {
    const ended = Boolean(taskRuns(db, taskId).find((r) => r.id === run.id)?.ended_at);
    if (existsSync(run.log_path)) {
      const size = statSync(run.log_path).size;
      if (size > offset) {
        const fd = openSync(run.log_path, 'r');
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        const whole = buf.lastIndexOf(10) + 1;
        if (whole > 0) {
          offset += whole;
          const entries = buf.toString('utf8', 0, whole).split('\n').flatMap(parseLogLine);
          if (entries.length) res.write(`id: ${offset}\ndata: ${JSON.stringify(entries)}\n\n`);
        }
      }
    }
    if (ended) {
      res.write('event: end\ndata: {}\n\n');
      res.end();
      stop();
    }
  };
  const timer = setInterval(pump, LOG_POLL_MS);
  const ping = setInterval(() => res.write(': ping\n\n'), pingMs);
  req.on('close', stop);
  pump();
}
