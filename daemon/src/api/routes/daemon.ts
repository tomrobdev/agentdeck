// The daemon as a whole: status, pause and resume, restart, the service and a test notification.
import * as actions from '../../application/actions.ts';
import { parseSince } from '../../domain/run/scorecard.ts';
import type { ChangeEvent } from '../contract.ts';
import { type ApiContext, BadRequest, type Route, route } from '../http.ts';

const PING_MS = 25_000;

export function routes({ db, daemon, changes }: ApiContext): Route[] {
  return [
    route('GET', /^\/api\/events$/, ({ req, res }) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (rev: number) => res.write(`event: rev\ndata: ${JSON.stringify({ rev } satisfies ChangeEvent)}\n\n`);
      send(changes.rev);
      const unsubscribe = changes.subscribe(send);
      const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
      req.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
    }),
    route('GET', /^\/api\/status$/, () => actions.status(db, daemon.info)),
    route('GET', /^\/api\/stats$/, ({ query }) => {
      const since = query.get('since');
      const by = query.get('by');
      if (by !== null && by !== 'week') throw new BadRequest('by takes week');
      if (since !== null && parseSince(since) === null) throw new BadRequest('since takes a date, like 2026-10-18');
      return actions.pilotStats(db, {
        repo: query.get('repo') || undefined,
        since: since === null ? undefined : (parseSince(since) ?? undefined),
        by: by === 'week' ? 'week' : undefined,
      });
    }),
    route('GET', /^\/api\/daemon$/, () => actions.daemonState(db, daemon.info, daemon.reloadFacts())),
    route('POST', /^\/api\/pause$/, () => (actions.setPaused(db, true), actions.status(db, daemon.info))),
    route('POST', /^\/api\/resume$/, () => (actions.setPaused(db, false), actions.status(db, daemon.info))),
    route('POST', /^\/api\/daemon\/restart$/, () => actions.restartDaemon(db, daemon.requestRestart)),
    route('GET', /^\/api\/daemon\/health$/, () => actions.daemonReport(db)),
    route('POST', /^\/api\/daemon\/restart-now$/, () => actions.restartNow(db, actions.restart)),
    route('GET', /^\/api\/service$/, () => actions.serviceStatus()),
    route('POST', /^\/api\/notify\/test$/, async () => (await actions.sendTestNotification(db), { ok: true })),
  ];
}
