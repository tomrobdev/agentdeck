// The daemon as a whole: the change stream, status, stats, pause and resume, restart, health, the service, a test notification and the desktop app saying it is running.
import * as actions from '../../application/actions.ts';
import { parseSince } from '../../domain/insights/scorecard.ts';
import type * as C from '../contract.ts';
import { type ApiContext, BadRequest, type Route, route } from '../http.ts';

const PING_MS = 25_000;

export function routes({ db, daemon, changes }: ApiContext): Route[] {
  return [
    route('GET', /^\/api\/events$/, ({ req, res }) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (rev: number) => res.write(`event: rev\ndata: ${JSON.stringify({ rev } satisfies C.ChangeEvent)}\n\n`);
      send(changes.rev);
      const unsubscribe = changes.subscribe(send);
      const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
      req.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
      return undefined; // the stream owns the response
    }),
    route<C.Status>('GET', /^\/api\/status$/, () => actions.status(db, daemon.info)),
    route<C.Stats>('GET', /^\/api\/stats$/, ({ query }) => {
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
    route<C.DaemonState>('GET', /^\/api\/daemon$/, () => actions.daemonState(db, daemon.info, daemon.reloadFacts())),
    route<C.Status>('POST', /^\/api\/pause$/, () => (actions.setPaused(db, true), actions.status(db, daemon.info))),
    route<C.Status>('POST', /^\/api\/resume$/, () => (actions.setPaused(db, false), actions.status(db, daemon.info))),
    route<C.RestartResult>('POST', /^\/api\/daemon\/restart$/, () => actions.restartDaemon(db, daemon.requestRestart)),
    route<C.DaemonHealth>('GET', /^\/api\/daemon\/health$/, () => actions.daemonReport(db)),
    route<C.RestartNowResult>('POST', /^\/api\/daemon\/restart-now$/, () => actions.restartNow(db, actions.restart)),
    route<C.ServiceStatus>('GET', /^\/api\/service$/, () => actions.serviceStatus()),
    route<C.TestNotifyResult>('POST', /^\/api\/notify\/test$/, async () => (await actions.sendTestNotification(db), { ok: true })),
    route<C.AppSeenResult>('POST', /^\/api\/app\/seen$/, () => actions.appSeen(db)),
  ];
}
