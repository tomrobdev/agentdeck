// Is the daemon healthy? Judges facts gathered elsewhere (launchd, the API, git, ps, the log) into one verdict per check,
// and for each failure the command that fixes it. Pure: `application/daemon/doctor.ts` gathers the facts.
import type { TaskId } from '../shared/index.ts';
import { plural } from '../shared/index.ts';
import { type ReloadState, SCHEMA_DIRTY } from './restart.ts';
import { type ReviewDue, checkReviews } from './review-due.ts';

/** What the daemon says about itself on GET /api/daemon. */
export interface DaemonState {
  /** The commit of the checkout the daemon loaded; null when it is not a git checkout. */
  commit: string | null;
  started_at: string;
  pid: number;
  reload: ReloadState;
}

/**
 * Why `run-once` may not start, from what answers on the API port (`running`, null for nothing): a daemon there runs the
 * same pending follow-ups, and the follow-up lock is per process, so both would open the same PRs. Null when it may start.
 */
export function runOnceRefusal(running: Pick<DaemonState, 'pid' | 'commit'> | null, port: number): string | null {
  if (!running) return null;
  const which = `pid ${running.pid}${running.commit ? `, ${running.commit.slice(0, 7)}` : ''}`;
  return `the agentdeck daemon is running (${which}, on port ${port}); stop it first (\`agentdeck service stop\`), or let it work the queue`;
}

export interface Check {
  name: string;
  ok: boolean;
  reason: string;
  /** For a failed check, or a warning: a command that fixes it. */
  fix: string | null;
  /** Passed, but something a person should look at (an area review due); never a failure. */
  warning?: boolean;
}

export interface ServiceFacts {
  installed: boolean;
  loaded: boolean;
  pid: number | null;
  state: string | null;
}

/** A claude process group recorded on a run, found alive. */
export interface ProcessFact {
  kind: 'work' | 'resolve' | 'unblock' | 'planner';
  run: number;
  pid: number;
  /** The run has a finished-at time. */
  ended: boolean;
}

/** A task in running (or being cancelled) and the process of its unfinished run, if any. */
export interface RunningTaskFact {
  id: TaskId;
  /** The recorded pid of its unfinished run; null when there is none or none was recorded yet. */
  pid: number | null;
  /** Whether that process group is alive. */
  alive: boolean;
  /** Seconds since its run started (the run row, before setup and the sync); null when it has no unfinished run. */
  runAgeSeconds: number | null;
}

/** Problems found in the daemon log. */
export interface LogFacts {
  /** Lines of the last 24 hours that look like errors. */
  problems: { at: number; line: string }[];
  /** The latest SIGTERM or SIGINT line, if it carries a time. */
  lastStop: { at: number; signal: string } | null;
}

export interface HealthFacts {
  now: number;
  service: ServiceFacts;
  port: number;
  /** The daemon's answer, or null when the API is not reachable. */
  api: DaemonState | null;
  /** HEAD of the checkout the CLI runs from, and how many commits it is ahead of the daemon's commit. */
  head: string | null;
  behind: number | null;
  /** The checkout's path, for the fix commands. */
  checkout: string;
  processes: ProcessFact[];
  tasks: RunningTaskFact[];
  /** null when there is no log file. */
  log: LogFacts | null;
  gh: { ok: boolean; output: string };
  /** The repos due for an area review. */
  reviews: ReviewDue[];
}

/** A run recorded as started: its pid may not be written yet this long after. */
export const PID_GRACE_SECONDS = 60;
/** How far back the log is read for errors. */
export const LOG_WINDOW_MS = 24 * 60 * 60 * 1000;

const short = (commit: string) => commit.slice(0, 7);

export function uptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const check = (name: string, ok: boolean, reason: string, fix: string | null = null): Check => ({
  name,
  ok,
  reason,
  fix: ok ? null : fix,
});

/** What brings the service up, or null when launchd already runs it. */
export function serviceFix(s: ServiceFacts): string | null {
  if (!s.installed) return 'agentdeck install';
  if (!s.loaded) return 'agentdeck service start';
  if (s.state !== 'running') return 'agentdeck restart --now';
  return null;
}

export function checkService(s: ServiceFacts): Check {
  if (!s.installed) return check('launchd service', false, 'the launchd agent is not installed', serviceFix(s));
  if (!s.loaded) return check('launchd service', false, 'installed but not loaded: the daemon is stopped', serviceFix(s));
  if (s.state !== 'running') return check('launchd service', false, `loaded but ${s.state ?? 'not running'}`, serviceFix(s));
  return check('launchd service', true, `running${s.pid ? `, pid ${s.pid}` : ''}`);
}

export function checkApi(f: Pick<HealthFacts, 'service' | 'port' | 'api' | 'now'>): Check {
  const name = 'daemon API';
  if (!f.api) {
    return check(name, false, `nothing answers on 127.0.0.1:${f.port}`, serviceFix(f.service) ?? 'agentdeck restart --now');
  }
  const { pid, started_at } = f.api;
  if (f.service.pid && f.service.pid !== pid) {
    return check(
      name,
      false,
      `answered by pid ${pid}, but launchd runs pid ${f.service.pid}: another daemon holds port ${f.port}`,
      `kill ${pid}`,
    );
  }
  return check(name, true, `answering on :${f.port}, pid ${pid}, up ${uptime(f.now - Date.parse(started_at))}`);
}

/** A check that needs the daemon's answer, when there is none. */
function notRun(name: string, f: Pick<HealthFacts, 'service'>): Check {
  return check(name, false, 'not run: the daemon is not answering', serviceFix(f.service) ?? 'agentdeck restart --now');
}

export function checkCode(f: Pick<HealthFacts, 'service' | 'api' | 'head' | 'behind'>): Check {
  const name = 'code loaded';
  if (!f.api) return notRun(name, f);
  const { commit } = f.api;
  if (!commit) return check(name, true, 'the daemon is not running from a git checkout');
  if (!f.head) return check(name, true, `${short(commit)} (the checkout's HEAD could not be read)`);
  if (commit === f.head) return check(name, true, `${short(commit)}, the checkout's HEAD`);
  const ahead = f.behind ? `, ${plural(f.behind, 'commit')} ahead` : '';
  return check(name, false, `the daemon loaded ${short(commit)}; the checkout is at ${short(f.head)}${ahead}`, 'agentdeck restart');
}

/** How to lift a block on reloading. */
function blockFix(blocked: string, checkout: string): string {
  return blocked === SCHEMA_DIRTY
    ? `git -C ${checkout} diff daemon/src/db/schema.ts   # commit or revert it`
    : `git -C ${checkout} switch main`;
}

export function checkReload(f: Pick<HealthFacts, 'service' | 'api' | 'checkout'>): Check {
  const name = 'reload';
  if (!f.api) return notRun(name, f);
  const { reload } = f.api;
  if (reload.blocked) return check(name, false, `blocked: ${reload.blocked}`, blockFix(reload.blocked, f.checkout));
  if (reload.pending) {
    const wait = reload.waiting ? `waiting for ${reload.waiting}` : (reload.reason ?? 'about to restart');
    return check(name, true, `pending, ${wait}`);
  }
  return check(name, true, reload.enabled ? 'none pending' : 'none pending (reload_on_change is off)');
}

const KIND_NAME = { work: 'run', resolve: 'resolve run', unblock: 'unblock run', planner: 'planner run' } as const;

export function checkProcesses(f: Pick<HealthFacts, 'processes' | 'api'>): Check {
  const name = 'claude processes';
  // A process of an unfinished run is the daemon's to look after, unless the daemon is gone.
  const strays = f.processes.filter((p) => p.ended || !f.api);
  if (!strays.length) return check(name, true, 'none left over');
  const what = strays.map((p) => `${KIND_NAME[p.kind]} ${p.run} (pid ${p.pid}, ${p.ended ? 'run ended' : 'daemon gone'})`);
  return check(
    name,
    false,
    `${plural(strays.length, 'claude process group')} still alive: ${what.join(', ')}`,
    `kill -TERM -- ${strays.map((p) => `-${p.pid}`).join(' ')}`,
  );
}

/**
 * Which running tasks have no claude working on them. While the daemon answers, only a run older than the daemon can
 * be dead: the daemon is working its own runs, and one between setup and claude, in a sync or in its tests has no
 * live claude and is fine. With the daemon down, a run is dead once its pid is overdue or its process is gone.
 */
export function checkTasks(f: Pick<HealthFacts, 'tasks' | 'api' | 'now'>): Check {
  const name = 'running tasks';
  // A run's start is stored to the second; the daemon's to the millisecond.
  const daemonAge = f.api ? (f.now - Date.parse(f.api.started_at)) / 1000 + 1 : null;
  const dead = f.tasks.filter((t) => {
    if (daemonAge !== null && (t.runAgeSeconds === null || t.runAgeSeconds <= daemonAge)) return false;
    if (t.pid === null) return t.runAgeSeconds === null || t.runAgeSeconds > PID_GRACE_SECONDS;
    return !t.alive;
  });
  if (!dead.length) {
    const each = f.api ? 'none left over from an earlier daemon' : 'each with a live process';
    return check(name, true, f.tasks.length ? `${plural(f.tasks.length, 'task')} running, ${each}` : 'none');
  }
  return check(
    name,
    false,
    `${plural(dead.length, 'task')} in running with no live claude process: ${dead.map((t) => `#${t.id}`).join(', ')}`,
    // The daemon requeues what a previous one left running as it starts.
    f.api ? 'agentdeck restart --now' : 'agentdeck service start',
  );
}

const STAMP = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] /;
const FRAME = /^\s+at /;
// What an error looks like in the log: a crash the scheduler reported, an error a stack starts with, or one Node printed itself.
const PROBLEM = /\bcrashed\b|^(?:\w*Error|Uncaught|Unhandled)\b|\bunhandled rejection\b/i;
const STOP = /^(SIGTERM|SIGINT):/;

/**
 * Pick the errors of the last 24 hours out of the log. Only lines with a time are dated; the ones after
 * them (a stack, a line printed by Node) belong to the time of the line before. Lines before any
 * dated one are of unknown age and left out.
 */
export function logFacts(lines: readonly string[], now: number): LogFacts {
  const facts: LogFacts = { problems: [], lastStop: null };
  let at: number | null = null;
  for (const raw of lines) {
    const m = raw.match(STAMP);
    if (m) at = Date.parse(m[1]);
    const text = m ? raw.slice(m[0].length) : raw;
    if (at === null || FRAME.test(text)) continue;
    const stop = text.match(STOP);
    if (m && stop) facts.lastStop = { at, signal: stop[1] };
    if (now - at <= LOG_WINDOW_MS && PROBLEM.test(text)) facts.problems.push({ at, line: text.trim().slice(0, 140) });
  }
  return facts;
}

export function checkLog(f: Pick<HealthFacts, 'log' | 'now'>): Check {
  const name = 'daemon.log';
  if (!f.log) return check(name, true, 'no log yet');
  const { problems, lastStop } = f.log;
  const stop = lastStop ? `; last stopped by ${lastStop.signal} ${uptime(f.now - lastStop.at)} ago` : '';
  if (!problems.length) return check(name, true, `no errors in the last 24 hours${stop}`);
  const last = problems[problems.length - 1];
  return check(
    name,
    false,
    `${plural(problems.length, 'error')} in the last 24 hours, the latest ${uptime(f.now - last.at)} ago: ${last.line}${stop}`,
    'agentdeck logs -n 200',
  );
}

export function checkGh(gh: HealthFacts['gh']): Check {
  return check('gh auth', gh.ok, gh.ok ? 'logged in' : `gh is not logged in: ${gh.output}`, 'gh auth login');
}

/** Every check, in the order they are shown. */
export function judgeHealth(f: HealthFacts): Check[] {
  return [
    checkService(f.service),
    checkApi(f),
    checkCode(f),
    checkReload(f),
    checkProcesses(f),
    checkTasks(f),
    checkLog(f),
    checkGh(f.gh),
    checkReviews(f.reviews),
  ];
}
