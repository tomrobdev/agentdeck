// Daemon commands: the service, the scheduler, pause, status and settings.
import * as actions from '../application/actions.ts';
import { startApi } from '../api/server.ts';
import { BUDGET_KEYS } from '../domain/usage/governor.ts';
import type { NotifyKind } from '../domain/notification.ts';
import { Scheduler } from '../application/scheduler.ts';
import * as service from '../adapters/service.ts';
import { API_PORT, DB_PATH, DEFAULTS } from '../config.ts';
import { die, relTime } from './format.ts';
import type { Command } from './context.ts';

/** `daemon` and `run-once` share one implementation; `cmd` says which was typed. */
const runScheduler: Command = async ({ db, cmd }) => {
  const once = cmd === 'run-once';
  const scheduler = new Scheduler(db, { once, keepAwake: !once });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      console.log(`${sig}: stopping workers; their tasks will be requeued on next start`);
      scheduler.stop();
      process.exit(0);
    });
  }
  if (!once) {
    const api = await startApi(db, API_PORT, () => scheduler.wake()).catch((err) => {
      if (err?.code === 'EADDRINUSE')
        die(`port ${API_PORT} is in use: another agentdeck daemon is probably running (see \`agentdeck service\`)`);
      throw err;
    });
    console.log(`api        http://127.0.0.1:${API_PORT}`);
    process.on('exit', () => api.close());
  }
  console.log(
    `agentdeck ${once ? 'run-once' : 'daemon'}: ${db.isPaused() && !once ? 'PAUSED (agentdeck resume to start)' : 'active'}, max ${db.maxConcurrent()} concurrent, tick ${DEFAULTS.tickMs / 1000}s`,
  );
  await scheduler.run();
};

export const daemonCommands: Record<string, Command> = {
  install: async () => {
    const st = await service.install();
    console.log(`installed ${st.plist}`);
    console.log(`daemon ${st.state ?? 'loading'}${st.pid ? ` (pid ${st.pid})` : ''}; it starts at login and restarts if it dies`);
    console.log(`logs: ~/.agentdeck/logs/daemon.log · runs ${st.program}`);
  },
  uninstall: async () => {
    await service.uninstall();
    console.log('removed the launchd agent; the daemon is stopped');
  },
  service: async () => {
    const st = await service.serviceStatus();
    console.log(`installed  ${st.installed ? st.plist : 'no'}`);
    console.log(`loaded     ${st.loaded ? `${st.state ?? '?'}${st.pid ? `, pid ${st.pid}` : ''}` : 'no'}`);
    console.log(`program    ${st.program}`);
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
    const on = (v: string) => ['1', 'on', 'true', 'yes'].includes(v.toLowerCase());
    if (key === 'max_concurrent') actions.updateSettings(db, { max_concurrent: Number(value) });
    else if ((BUDGET_KEYS as string[]).includes(key)) actions.updateSettings(db, { budget: { [key]: Number(value) } });
    else if (key === 'notify_desktop') actions.updateSettings(db, { notify: { desktop: on(value) } });
    else if (key === 'notify_events') actions.updateSettings(db, { notify: { events: value.split(',').filter(Boolean) as NotifyKind[] } });
    else if (key === 'ntfy_topic' || key === 'ntfy_server') actions.updateSettings(db, { notify: { [key]: value } });
    else if (key === 'planner_enabled') actions.updateSettings(db, { planner: { enabled: on(value) } });
    else if (key === 'planner_interval_hours') actions.updateSettings(db, { planner: { interval_hours: Number(value) } });
    else if (key === 'planner_max_tasks') actions.updateSettings(db, { planner: { max_tasks: Number(value) } });
    else if (key === 'planner_model') actions.updateSettings(db, { planner: { model: value } });
    else die(`unknown setting "${key}"; see agentdeck help`);
    console.log(`${key} = ${value}`);
  },
  settings: ({ db }) => {
    const st = actions.getSettings(db);
    const d = actions.status(db).governor;
    console.log(`max_concurrent  ${st.max_concurrent}`);
    for (const [k, v] of Object.entries(st.budget)) console.log(`${k.padEnd(15)} ${v}`);
    console.log(`notify_desktop  ${st.notify.desktop ? 'on' : 'off'}`);
    console.log(`notify_events   ${st.notify.events.join(',') || '-'}`);
    console.log(`ntfy            ${st.notify.ntfy_topic ? `${st.notify.ntfy_server}/${st.notify.ntfy_topic}` : 'off'}`);
    console.log(
      `planner         ${st.planner.enabled ? 'on' : 'off'}, every ${st.planner.interval_hours}h when a queue is empty, up to ${st.planner.max_tasks} tasks, ${st.planner.model}`,
    );
    console.log(
      `\ngovernor        ${d.allow ? 'allowing work' : 'holding'}${d.reason ? `: ${d.reason}` : ''}${d.until ? ` (lifts in ${relTime(d.until)})` : ''}`,
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
