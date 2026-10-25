// The daemon as a whole: status, pause and resume, restart, the service and a test notification.
import * as actions from '../../application/actions.ts';
import { type ApiContext, type Route, route } from '../http.ts';

export function routes({ db, daemon }: ApiContext): Route[] {
  return [
    route('GET', /^\/api\/status$/, () => actions.status(db, daemon.info)),
    route('POST', /^\/api\/pause$/, () => (actions.setPaused(db, true), actions.status(db, daemon.info))),
    route('POST', /^\/api\/resume$/, () => (actions.setPaused(db, false), actions.status(db, daemon.info))),
    route('POST', /^\/api\/daemon\/restart$/, () => actions.restartDaemon(db, daemon.requestRestart)),
    route('GET', /^\/api\/service$/, () => actions.serviceStatus()),
    route('POST', /^\/api\/notify\/test$/, async () => (await actions.sendTestNotification(db), { ok: true })),
  ];
}
