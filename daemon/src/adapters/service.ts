// Runs the daemon as a per-user launchd agent: starts at login, restarted if it dies.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HOME, LOG_DIR, ensureDirs } from '../config.ts';

const exec = promisify(execFile);

export const LABEL = 'dev.agentdeck.daemon';
export const PLIST_PATH = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
// The installed plist runs this path, so the entry point stays at src/cli.ts.
const CLI_PATH = resolve(import.meta.dirname, '../cli.ts');
const domain = () => `gui/${userInfo().uid}`;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** launchd gives agents a bare PATH; spell out where node, git and claude live. */
export function servicePath(): string {
  const dirs = [
    dirname(process.execPath),
    join(homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return [...new Set(dirs)].join(':');
}

export function renderPlist(): string {
  const env: Record<string, string> = { PATH: servicePath(), HOME: homedir() };
  if (process.env.AGENTDECK_HOME) env.AGENTDECK_HOME = HOME;
  const log = DAEMON_LOG;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(CLI_PATH)}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`)
  .join('\n')}
  </dict>
  <key>WorkingDirectory</key><string>${xml(homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

export interface ServiceStatus {
  installed: boolean;
  loaded: boolean;
  pid: number | null;
  state: string | null;
  plist: string;
  program: string;
}

export async function serviceStatus(): Promise<ServiceStatus> {
  const base = { installed: existsSync(PLIST_PATH), loaded: false, pid: null, state: null, plist: PLIST_PATH, program: CLI_PATH };
  try {
    const { stdout } = await exec('launchctl', ['print', `${domain()}/${LABEL}`]);
    const pid = stdout.match(/^\s*pid = (\d+)/m);
    const state = stdout.match(/^\s*state = (\S+)/m);
    return { ...base, loaded: true, pid: pid ? Number(pid[1]) : null, state: state?.[1] ?? null };
  } catch {
    return base;
  }
}

async function bootout(): Promise<void> {
  try {
    await exec('launchctl', ['bootout', `${domain()}/${LABEL}`]);
  } catch {
    // not loaded
  }
}

export const DAEMON_LOG = join(LOG_DIR, 'daemon.log');

/** Print the last `lines` of the daemon log to stdout; with `follow`, keep printing until interrupted. */
export function tailLog(lines: number, follow: boolean): Promise<void> {
  if (!existsSync(DAEMON_LOG)) throw new Error(`no log yet at ${DAEMON_LOG}`);
  return new Promise((resolve, reject) => {
    const child = spawn('tail', ['-n', String(lines), ...(follow ? ['-f'] : []), DAEMON_LOG], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', () => resolve());
  });
}

/** Load the installed plist without rewriting it. */
export async function start(): Promise<ServiceStatus> {
  if (!existsSync(PLIST_PATH)) throw new Error('the service is not installed; run `agentdeck install`');
  if ((await serviceStatus()).loaded) throw new Error('the service is already started');
  await exec('launchctl', ['bootstrap', domain(), PLIST_PATH]);
  return waitRunning();
}

/** Unload the service so the daemon stops, keeping the plist (it starts again at login or with `service start`). */
export async function stop(): Promise<void> {
  if (!(await serviceStatus()).loaded) throw new Error('the service is not running');
  await exec('launchctl', ['bootout', `${domain()}/${LABEL}`]);
}

/** Kill the daemon and let launchd start it again on whatever code is on disk. */
export async function restart(): Promise<ServiceStatus> {
  const st = await serviceStatus();
  if (!st.installed) throw new Error('the service is not installed; run `agentdeck install`');
  if (!st.loaded) return start();
  await exec('launchctl', ['kickstart', '-k', `${domain()}/${LABEL}`]);
  return waitRunning();
}

// launchd reports a transient spawn state for a moment; wait briefly for "running".
async function waitRunning(): Promise<ServiceStatus> {
  for (let i = 0; i < 20; i++) {
    const st = await serviceStatus();
    if (st.state === 'running') return st;
    await new Promise((r) => setTimeout(r, 150));
  }
  return serviceStatus();
}

/** Write the plist and (re)load it. The daemon starts right away and at every login. */
export async function install(): Promise<ServiceStatus> {
  ensureDirs();
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, renderPlist());
  await bootout();
  await exec('launchctl', ['bootstrap', domain(), PLIST_PATH]);
  return waitRunning();
}

export async function uninstall(): Promise<void> {
  await bootout();
  rmSync(PLIST_PATH, { force: true });
}
