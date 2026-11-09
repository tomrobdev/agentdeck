// Where the end-to-end tests serve the dashboard and the scratch daemon: ports of their own, so a person's dev server
// (1420) and daemon (4317) can keep running.
export const DAEMON_PORT = Number(process.env.UI_DAEMON_PORT ?? 4391);
export const APP_PORT = Number(process.env.UI_APP_PORT ?? 1430);
export const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;
