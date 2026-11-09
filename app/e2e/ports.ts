// Where the end-to-end tests serve the dashboard and the scratch daemon. Free ports picked once per run, so a person's
// dev server (1420) and daemon (4317) keep running, and two runs at once (two tasks' checks in the daemon's two slots)
// don't take each other's ports. The ports go into the environment: Playwright's worker processes inherit it, so they
// read the same ones. UI_DAEMON_PORT and UI_APP_PORT, when set, are used as they are.
import { execFileSync } from 'node:child_process';

/** A port nothing listens on now, from the OS (port 0). Synchronous: the config is loaded without top-level await. */
function freePort(): string {
  const script =
    "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
  return execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();
}

process.env.UI_DAEMON_PORT ??= freePort();
process.env.UI_APP_PORT ??= freePort();

export const DAEMON_PORT = Number(process.env.UI_DAEMON_PORT);
export const APP_PORT = Number(process.env.UI_APP_PORT);
export const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;
