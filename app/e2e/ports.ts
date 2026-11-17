import { execFileSync } from 'node:child_process';

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
export const API_TOKEN: string = (process.env.AGENTDECK_API_TOKEN ||= 'ui-test-token');
