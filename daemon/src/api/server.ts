// Local HTTP API for the dashboard: JSON endpoints plus a Server-Sent Events log tail.
import { type Server, createServer } from 'node:http';
import { API_PORT } from '../config.ts';
import type { ComposedApp } from '../application/actions.ts';
import { type ApiContext, type ApiScheduler, dispatch } from './http.ts';
import * as daemonRoutes from './routes/operations/daemon.ts';
import * as filesRoutes from './routes/work/files.ts';
import * as plansRoutes from './routes/work/plans.ts';
import * as pullRequestsRoutes from './routes/landing/pull-requests.ts';
import * as reposRoutes from './routes/repos/repos.ts';
import * as reviewsRoutes from './routes/landing/reviews.ts';
import * as settingsRoutes from './routes/operations/settings.ts';
import * as tasksRoutes from './routes/work/tasks.ts';

const idleScheduler: ApiScheduler = { wake: () => {}, track: (p) => p };

const idleChanges: ApiContext['changes'] = { rev: 1, subscribe: () => () => {} };

export interface ApiOptions {
  db: ComposedApp;
  port?: number;
  scheduler?: ApiScheduler;
  changes?: ApiContext['changes'];
  daemon?: ApiContext['daemon'];
}

export function startApi(options: ApiOptions): Promise<Server> {
  const ctx: ApiContext = {
    db: options.db,
    scheduler: options.scheduler ?? idleScheduler,
    changes: options.changes ?? idleChanges,
    daemon: options.daemon ?? {
      info: { commit: null, started_at: new Date().toISOString(), pid: process.pid },
      requestRestart: () => {},
      reloadFacts: () => ({ changed: [], lastChangeAt: null }),
    },
  };
  const routes = [
    daemonRoutes,
    settingsRoutes,
    reposRoutes,
    tasksRoutes,
    pullRequestsRoutes,
    filesRoutes,
    plansRoutes,
    reviewsRoutes,
  ].flatMap((m) => m.routes(ctx));

  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      res.once('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) ctx.scheduler.wake();
      });
    }
    return dispatch(routes, req, res).catch((err) => {
      console.error(err);
      res.destroy();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? API_PORT, '127.0.0.1', () => resolve(server));
  });
}
