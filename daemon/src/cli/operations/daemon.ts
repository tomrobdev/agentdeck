// Daemon commands: the service, the scheduler, pause, status and settings.
import * as actions from '../../application/actions.ts';
import { DB_PATH } from '../../config.ts';
import { runDaemon } from '../../daemon.ts';
import { logsOptions, restartOptions, serviceAction } from './daemon-args.ts';
import { die, printHealth, relTime } from '../format.ts';
import { settingPatch } from './settings-args.ts';
import type { Command } from '../context.ts';

/** Adapter failures are plain Errors with a message fit to print. */
async function launchd<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return die(err instanceof Error ? err.message : String(err));
  }
}

/** `daemon` and `run-once` share one implementation; `cmd` says which was typed. */
const runScheduler: Command = async ({ db, cmd }) => {
  await runDaemon({ db, once: cmd === 'run-once', log: console.log }).catch((err) => die(err instanceof Error ? err.message : String(err)));
};

export const daemonCommands: Record<string, Command> = {
  install: async ({ db }) => {
    const st = await actions.installService(db);
    console.log(`installed ${st.plist}`);
    console.log(`daemon ${st.state ?? 'loading'}${st.pid ? ` (pid ${st.pid})` : ''}; it starts at login and restarts if it dies`);
    console.log(`logs: ~/.agentdeck/logs/daemon.log · runs ${st.program}`);
  },
  uninstall: async ({ db }) => {
    await actions.uninstallService(db);
    console.log('removed the launchd agent; the daemon is stopped');
  },
  service: async ({ db, rest }) => {
    const action = serviceAction(rest);
    if (action === 'start') {
      const st = await launchd(() => actions.startService(db));
      console.log(`service started: daemon ${st.state ?? 'loading'}${st.pid ? ` (pid ${st.pid})` : ''}`);
    } else if (action === 'stop') {
      await launchd(() => actions.stopService(db));
      console.log(`service stopped; the plist is kept (\`agentdeck service start\` brings it back, \`agentdeck uninstall\` removes it)`);
    } else {
      const st = await actions.serviceStatus(db);
      console.log(`installed ${st.installed ? st.plist : 'no'}`);
      console.log(`loaded     ${st.loaded ? `${st.state ?? '?'}${st.pid ? `, pid ${st.pid}` : ''}` : 'no'}`);
      console.log(`program    ${st.program}`);
    }
  },
  restart: async ({ db, flags, rest }) => {
    const { graceful } = restartOptions(flags, rest);
    const st = await actions.serviceStatus(db);
    if (!st.installed) die('the service is not installed; run `agentdeck install`');
    if (graceful && st.loaded) {
      let interrupted = false;
      process.once('SIGINT', () => (interrupted = true));
      await launchd(() =>
        actions.gracefulRestart(db, { restart: () => actions.restartService(db), log: console.log, aborted: () => interrupted }),
      );
    } else {
      const running = actions.runningCount(db);
      if (running && st.loaded) console.log(`restarting at once: ${running} running task(s) lose their run and are requeued`);
      await launchd(() => actions.restartService(db));
    }
    console.log('agentdeck daemon restarted');
  },
  logs: async ({ db, flags, rest }) => {
    const { lines, follow } = logsOptions(flags, rest);
    await launchd(() => actions.tailDaemonLog(db, lines, follow));
  },
  doctor: async ({ db, flags }) => {
    const checks = await actions.daemonHealth(db);
    if (flags.json) console.log(JSON.stringify({ ok: checks.every((c) => c.ok), checks }, null, 2));
    else printHealth(checks);
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
  },
  pause: ({ db }) => {
    actions.setPaused(db, true);
    console.log('paused: running tasks finish, no new ones start');
  },
  resume: ({ db }) => {
    actions.setPaused(db, false);
    console.log('resumed');
  },
  set: ({ db, rest }) => {
    const [key, value = ''] = rest;
    actions.updateSettings(db, settingPatch(key, value));
    console.log(`${key} = ${value}`);
  },
  settings: ({ db }) => {
    const st = actions.getSettings(db);
    const d = actions.status(db).governor;
    console.log(`max_concurrent  ${st.max_concurrent}`);
    for (const [k, v] of Object.entries(st.budget)) console.log(`${k.padEnd(15)} ${v}`);
    console.log(`reload_on_change ${st.reload_on_change ? 'on' : 'off'}`);
    console.log(`notify_desktop  ${st.notify.desktop ? 'on' : 'off'}`);
    console.log(`notify_events   ${st.notify.events.join(',') || '-'}`);
    console.log(`ntfy            ${st.notify.ntfy_topic ? `${st.notify.ntfy_server}/${st.notify.ntfy_topic}` : 'off'}`);
    console.log(
      `planner         ${st.planner.enabled ? 'on' : 'off'}, every ${st.planner.interval_hours}h when a queue is empty, up to ${st.planner.max_tasks} tasks, ${st.planner.model}`,
    );
    console.log(`default_model   ${st.default_model}`);
    console.log(`support_model   ${st.support_model} (resolve and unblock runs)`);
    console.log(`review_model    ${st.review_model} (review runs)`);
    console.log(`review_due_days  ${st.review_due.days} (an area review is due once the oldest mark is older)`);
    console.log(`review_due_lines ${st.review_due.lines} (or once more lines merged since it)`);
    console.log(
      `\ngovernor        ${d.allow ? 'allowing work' : 'on hold'}${d.reason ? `: ${d.reason}` : ''}${d.until ? ` (lifts in ${relTime(d.until)})` : ''}`,
    );
    if (d.weekly_allowed !== null) console.log(`weekly pace     ${Math.round(d.weekly_allowed * 100)}% of the 7d window allowed so far`);
  },
  'notify-test': async ({ db }) => {
    await actions.sendTestNotification(db);
    console.log('sent');
  },
  status: ({ db }) => {
    const st = actions.status(db);
    const limited = st.rate_limited_until && st.rate_limited_until * 1000 > Date.now();
    console.log(
      `state      ${st.paused ? 'PAUSED' : 'active'}${limited ? ` (rate limited, resumes in ${relTime(st.rate_limited_until!)})` : ''}`,
    );
    console.log(`slots      ${st.running}/${st.max_concurrent} running`);
    if (st.governor.reason)
      console.log(
        `governor   ${st.governor.allow ? '' : 'HOLD: '}${st.governor.reason}${st.governor.until ? ` (lifts in ${relTime(st.governor.until)})` : ''}`,
      );
    for (const r of st.paused_repos)
      console.log(
        `repo       ${r.name} PAUSED (${r.queued} queued): ${r.reason.split('\n')[0].slice(0, 100)}  → agentdeck repo resume ${r.name}`,
      );
    for (const r of st.headline.review_due) console.log(`repo       ${r.repo}: ${r.line}`);
    console.log(
      `tasks      ${
        Object.entries(st.counts)
          .map(([k, n]) => `${k} ${n}`)
          .join(', ') || 'none'
      }`,
    );
    for (const w of st.usage) {
      console.log(
        `usage      ${w.window.padEnd(10)} ${(w.utilization * 100).toFixed(0).padStart(3)}%  resets in ${relTime(w.resets_at)}  (seen ${w.observed_at} UTC)`,
      );
    }
    console.log(`db         ${DB_PATH}`);
  },
  daemon: runScheduler,
  'run-once': runScheduler,
};
