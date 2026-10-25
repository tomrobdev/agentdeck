// Local HTTP API for the dashboard: JSON endpoints plus a Server-Sent Events log tail.
import { type Server, createServer } from 'node:http';
import { API_PORT } from '../config.ts';
import type { Db } from '../db/index.ts';
import { type ApiContext, type ApiScheduler, dispatch } from './http.ts';
import * as daemonRoutes from './routes/daemon.ts';
import * as filesRoutes from './routes/files.ts';
import * as plansRoutes from './routes/plans.ts';
import * as reposRoutes from './routes/repos.ts';
import * as settingsRoutes from './routes/settings.ts';
import * as tasksRoutes from './routes/tasks.ts';

export type { ApiScheduler } from './http.ts';

const idleScheduler: ApiScheduler = { wake: () => {}, track: (p) => p };

export interface ApiOptions {
  db: Db;
  port?: number;
  scheduler?: ApiScheduler;
  daemon?: ApiContext['daemon'];
}

/** Start the API on 127.0.0.1. The positional form `startApi(db, port, scheduler, daemon)` is the same call. */
export function startApi(options: ApiOptions): Promise<Server>;
export function startApi(db: Db, port?: number, scheduler?: ApiScheduler, daemon?: ApiContext['daemon']): Promise<Server>;
export function startApi(first: ApiOptions | Db, port?: number, scheduler?: ApiScheduler, daemon?: ApiContext['daemon']): Promise<Server> {
  const options: ApiOptions = 'db' in first ? first : { db: first, port, scheduler, daemon };
  const ctx: ApiContext = {
    db: options.db,
    scheduler: options.scheduler ?? idleScheduler,
    daemon: options.daemon ?? { info: { commit: null, started_at: new Date().toISOString() }, requestRestart: () => {} },
  };
  const routes = [daemonRoutes, settingsRoutes, reposRoutes, tasksRoutes, filesRoutes, plansRoutes].flatMap((m) => m.routes(ctx));

  const server = createServer((req, res) => void dispatch(routes, req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? API_PORT, '127.0.0.1', () => resolve(server));
  });
}
