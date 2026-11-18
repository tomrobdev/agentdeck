// The daemon as a whole: the change stream, status, stats, pause and resume, restart, health, the service, a test notification and the desktop app saying it is running.
import * as actions from '#application/actions.ts';
import { parseSince } from '#domain/insights/index.ts';
import type {
  AppSeenResult,
  ChangeEvent,
  DaemonHealth,
  DaemonState,
  RestartNowResult,
  RestartResult,
  ServiceStatus,
  Status,
  TestNotifyResult,
} from '#api/contract/operations.ts';
import type { Stats } from '#api/contract/insights.ts';
import { type ApiContext, BadRequest, type Route, route } from '#api/http.ts';

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
      return undefined;
    }),
    route<Status>('GET', /^\/api\/status$/, () => actions.status(db, daemon.info)),
    route<Stats>('GET', /^\/api\/stats$/, ({ query }) => {
      const since = query.get('since');
      const by = query.get('by');
      if (by !== null && by !== 'week' && by !== 'model') throw new BadRequest('by takes week or model');
      if (since !== null && parseSince(since) === null) throw new BadRequest('since takes a date, like 2026-10-18');
      return actions.pilotStats(db, {
        repo: query.get('repo') || undefined,
        since: since === null ? undefined : (parseSince(since) ?? undefined),
        by: by ?? undefined,
      });
    }),
    route<DaemonState>('GET', /^\/api\/daemon$/, () => actions.daemonState(db, daemon.info, daemon.reloadFacts())),
    route<Status>('POST', /^\/api\/pause$/, () => (actions.setPaused(db, true), actions.status(db, daemon.info))),
    route<Status>('POST', /^\/api\/drain$/, () => (actions.drain(db), actions.status(db, daemon.info))),
    route<Status>('POST', /^\/api\/resume$/, () => (actions.setPaused(db, false), actions.status(db, daemon.info))),
    route<RestartResult>('POST', /^\/api\/daemon\/restart$/, () => actions.restartDaemon(db, daemon.requestRestart)),
    route<DaemonHealth>('GET', /^\/api\/daemon\/health$/, () => actions.daemonReport(db)),
    route<RestartNowResult>('POST', /^\/api\/daemon\/restart-now$/, () => actions.restartNow(db, () => actions.restartService(db))),
    route<ServiceStatus>('GET', /^\/api\/service$/, () => actions.serviceStatus(db)),
    route<TestNotifyResult>('POST', /^\/api\/notify\/test$/, async () => (await actions.sendTestNotification(db), { ok: true })),
    route<AppSeenResult>('POST', /^\/api\/app\/seen$/, () => actions.appSeen(db)),
  ];
}
