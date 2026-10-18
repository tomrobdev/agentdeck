import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as actions from './actions.ts';
import { startApi } from './api.ts';
import { API_PORT, DB_PATH, DEFAULTS } from './config.ts';
import { type Db, type PrMode, type Task, type TaskStatus, openDb } from './db.ts';
import { isWaiting } from './domain/pr.ts';
import { removeWorktree } from './git.ts';
import { BUDGET_KEYS } from './governor.ts';
import type { NotifyKind } from './notify.ts';
import { Scheduler } from './scheduler.ts';
import * as service from './service.ts';

const HELP = `agentdeck: always-on Claude Code task queue

Repos
  agentdeck repo add <path> [--name n] [--base main] [--test "npm test"] [--setup "npm ci"] [--tools "Read,Edit,Bash(npm *)"]
                                                  the toolchain is detected; flags override what it suggests
  agentdeck repo ls
  agentdeck repo doctor <repo>                    check the repo is ready for unattended runs; pauses it if not (exit 1)
  agentdeck repo resume <repo>                    let a paused repo's tasks run again
  agentdeck repo set <repo> auto_approve on|off   planner tasks skip approval
  agentdeck repo set <repo> base_branch <branch>  branch new task worktrees start from
  agentdeck repo set <repo> test_cmd "<cmd>"      run after each task ("" for none)
  agentdeck repo set <repo> setup_cmd "<cmd>"     run in each worktree before claude ("" for none)
  agentdeck repo set <repo> pr_mode off|draft|ready  push and open a PR when a task is done
  agentdeck goals <repo> [--file goals.md]        show (or replace) the goals the planner works from
  agentdeck plan <repo>                           run the planner now

Tasks
  agentdeck add "<prompt>" --repo <name> [--title t] [--priority n] [--model sonnet] [--max-turns n] [--attempts n]
                      [--after <task>]          wait until that task is done (and its PR merged, if it has one)
  agentdeck edit <id> [--title t] [--prompt p] [--priority n] [--model m] [--max-turns n] [--attempts n]
                                  for proposed, queued, blocked or failed tasks
  agentdeck ls [--status proposed|queued|running|done|blocked|failed|cancelled]
  agentdeck show <id>
  agentdeck log <id> [--attempt n] [--raw]
  agentdeck approve <id>...       queue planner proposals
  agentdeck reject <id>...
  agentdeck cancel <id>
  agentdeck retry <id>
  agentdeck clean <id>          remove the task's worktree (its branch is kept)

Daemon
  agentdeck install             run the daemon at login via launchd (restarted if it dies)
  agentdeck uninstall
  agentdeck service             launchd status
  agentdeck daemon              run the scheduler in the foreground
  agentdeck run-once            work the queue until empty, then exit (ignores pause)
  agentdeck pause | resume
  agentdeck status
  agentdeck settings              show concurrency, usage budget and notification settings
  agentdeck set <key> <value>     max_concurrent, five_hour_max, five_hour_soft, weekly_max, pace_slack (0..1),
                                  notify_desktop (on|off), notify_events (done,blocked,failed,hold,proposed), ntfy_topic, ntfy_server,
                                  planner_enabled (on|off), planner_interval_hours, planner_max_tasks, planner_model
  agentdeck notify-test           send a test notification on every enabled channel
`;

const STATUS_ICON: Record<TaskStatus, string> = {
  proposed: '?',
  queued: '·',
  running: '▶',
  done: '✓',
  blocked: '!',
  failed: '✗',
  cancel_requested: '⏹',
  cancelled: '⏹',
};

function die(msg: string): never {
  console.error(`agentdeck: ${msg}`);
  process.exit(1);
}

function taskId(arg: string | undefined): number {
  const id = Number(arg);
  if (!Number.isInteger(id) || id <= 0) die('expected a task id');
  return id;
}

function fmtTask(t: Task, repoName: string, db?: Db): string {
  let extra = t.blocked_reason && (t.status === 'blocked' || t.status === 'failed') ? `  — ${t.blocked_reason}` : '';
  if (t.status === 'queued' && t.after_task !== null && db && isWaiting(t, db.getTask(t.after_task)))
    extra += `  waiting on #${t.after_task}`;
  if (t.pr_url) extra += `  PR ${t.pr_state ?? 'open'}: ${t.pr_url}`;
  return `${STATUS_ICON[t.status]} #${String(t.id).padEnd(4)} ${t.status.padEnd(9)} p${t.priority}  ${repoName.padEnd(14)} ${t.title}${extra}`;
}

/** Print each doctor check with its reason, then the verdict. */
function printDoctor(report: actions.DoctorReport): actions.DoctorReport {
  for (const c of report.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name.padEnd(14)} ${c.reason}`);
  console.log(
    report.ok
      ? `${report.repo}: ready`
      : `${report.repo}: PAUSED (${report.paused_reason}); fix the failed checks and run \`agentdeck repo doctor ${report.repo}\``,
  );
  return report;
}

function relTime(unixSeconds: number): string {
  const mins = Math.round((unixSeconds * 1000 - Date.now()) / 60_000);
  if (mins <= 0) return 'now';
  return mins < 90 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`;
}

/** Print a run's log in readable form. */
function printLog(path: string): void {
  for (const e of actions.readLog(path)) {
    if (e.kind === 'text') console.log(`\n💬 ${e.text}`);
    if (e.kind === 'tool') console.log(`🔧 ${e.name} ${e.input.slice(0, 200)}`);
    if (e.kind === 'result') console.log(`\n── result: ${e.subtype}, ${e.turns} turns, $${e.cost.toFixed(3)} equiv ──`);
    if (e.kind === 'setup') console.log(`\n── setup ${e.passed ? 'done' : 'FAILED'}: ${e.cmd} ──\n${e.output.slice(-3000)}`);
    if (e.kind === 'tests') console.log(`\n── tests ${e.passed ? 'passed' : 'FAILED'} ──\n${e.output.slice(-3000)}`);
    if (e.kind === 'error') console.log(`⚠️  ${e.text}`);
  }
}

async function main(argv: string[]): Promise<void> {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      base: { type: 'string' },
      test: { type: 'string' },
      setup: { type: 'string' },
      tools: { type: 'string' },
      prompt: { type: 'string' },
      repo: { type: 'string', short: 'r' },
      title: { type: 'string', short: 't' },
      priority: { type: 'string', short: 'p' },
      model: { type: 'string', short: 'm' },
      'max-turns': { type: 'string' },
      attempts: { type: 'string' },
      after: { type: 'string' },
      status: { type: 'string', short: 's' },
      attempt: { type: 'string' },
      raw: { type: 'boolean' },
      file: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || flags.help || cmd === 'help') return void console.log(HELP);

  const db = openDb();
  const repoName = (id: number) => db.getRepo(id)?.name ?? `repo${id}`;

  switch (cmd) {
    case 'repo': {
      const [sub, path] = rest;
      if (sub === 'add') {
        if (!path) die('repo add needs a path');
        const repo = await actions.addRepo(db, {
          path,
          name: flags.name,
          base: flags.base,
          test: flags.test,
          setup: flags.setup,
          tools: flags.tools?.split(',').map((t) => t.trim()),
        });
        console.log(
          `added repo "${repo.name}" (${repo.path}, base ${repo.base_branch}, toolchain ${repo.toolchain ?? 'unknown'}${repo.setup_cmd ? `, setup: ${repo.setup_cmd}` : ''}${repo.test_cmd ? `, tests: ${repo.test_cmd}` : ''})`,
        );
        // The repo is added either way; a failed doctor pauses it and says so, without failing the command.
        printDoctor(await actions.doctorRepo(db, repo.id));
      } else if (sub === 'doctor') {
        if (!path) die('usage: agentdeck repo doctor <repo>');
        console.log(`checking ${path}… (this runs the repo's setup and test commands)`);
        if (!printDoctor(await actions.doctorRepo(db, path)).ok) process.exitCode = 1;
      } else if (sub === 'resume') {
        if (!path) die('usage: agentdeck repo resume <repo>');
        const repo = actions.resumeRepo(db, path);
        console.log(`${repo.name}: resumed`);
      } else if (sub === 'set') {
        const [, name, key, value = ''] = rest;
        if (!name || !['auto_approve', 'base_branch', 'test_cmd', 'setup_cmd', 'pr_mode'].includes(key))
          die(
            'usage: agentdeck repo set <repo> auto_approve on|off | base_branch <branch> | test_cmd "<cmd>" | setup_cmd "<cmd>" | pr_mode off|draft|ready',
          );
        if (key === 'pr_mode') actions.updateRepo(db, name, { pr_mode: value as PrMode });
        else if (key === 'auto_approve')
          actions.updateRepo(db, name, { auto_approve: ['1', 'on', 'true', 'yes'].includes(value.toLowerCase()) });
        else if (key === 'base_branch') actions.updateRepo(db, name, { base_branch: value });
        else if (key === 'setup_cmd') actions.updateRepo(db, name, { setup_cmd: value });
        else actions.updateRepo(db, name, { test_cmd: value });
        console.log(`${name}: ${key} ${value || '(none)'}`);
      } else if (sub === 'ls' || !sub) {
        for (const r of db.listRepos()) {
          const goals = actions.repoDetail(db, r.id).goals.trim() ? 'goals ✓' : 'no goals';
          console.log(
            `${r.name.padEnd(16)} ${r.path}  base=${r.base_branch}  toolchain=${r.toolchain ?? '-'}  setup=${r.setup_cmd ?? '-'}  test=${r.test_cmd ?? '-'}  pr=${r.pr_mode}  ${goals}${r.auto_approve ? '  auto-approve' : ''}${r.paused_reason ? `  PAUSED (${r.paused_reason})` : ''}`,
          );
        }
      } else die(`unknown repo command: ${sub}`);
      break;
    }

    case 'add': {
      const t = actions.addTask(db, {
        repo: flags.repo,
        prompt: rest.join(' '),
        title: flags.title,
        priority: flags.priority ? Number(flags.priority) : undefined,
        model: flags.model,
        max_turns: flags['max-turns'] ? Number(flags['max-turns']) : undefined,
        max_attempts: flags.attempts ? Number(flags.attempts) : undefined,
        after_task: flags.after ? taskId(flags.after) : undefined,
      });
      console.log(
        `queued task #${t.id} on ${repoName(t.repo_id)} (${t.model}, ${t.max_turns} turns max${t.after_task ? `, after #${t.after_task}` : ''})`,
      );
      if (db.isPaused()) console.log('note: the daemon is paused; run `agentdeck resume` to start working');
      break;
    }

    case 'edit': {
      const id = taskId(rest[0]);
      // A blank or non-numeric value becomes NaN, which editTask rejects.
      const num = (v: string | undefined) => (v === undefined ? undefined : v.trim() === '' ? NaN : Number(v));
      const t = actions.editTask(db, id, {
        title: flags.title,
        prompt: flags.prompt,
        priority: num(flags.priority),
        model: flags.model,
        max_turns: num(flags['max-turns']),
        max_attempts: num(flags.attempts),
      });
      console.log(fmtTask(t, repoName(t.repo_id)));
      console.log(`model ${t.model}, attempts ${t.attempts}/${t.max_attempts}, max turns ${t.max_turns}`);
      break;
    }

    case 'ls': {
      const tasks = db.listTasks(flags.status as TaskStatus | undefined);
      if (!tasks.length) console.log('no tasks');
      for (const t of tasks) console.log(fmtTask(t, repoName(t.repo_id), db));
      break;
    }

    case 'show': {
      const t = db.getTask(taskId(rest[0])) ?? die('no such task');
      console.log(fmtTask(t, repoName(t.repo_id), db));
      console.log(`model ${t.model}, attempts ${t.attempts}/${t.max_attempts}, max turns ${t.max_turns}`);
      if (t.branch) console.log(`branch   ${t.branch}`);
      if (t.worktree) console.log(`worktree ${t.worktree}`);
      console.log(`\n${t.prompt}\n`);
      for (const r of db.runsForTask(t.id)) {
        const tokens = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
        console.log(
          `run ${r.attempt}: ${r.outcome ?? 'running'}  turns=${r.num_turns ?? '-'}  tokens=${tokens}  tests=${r.tests_passed === null ? '-' : r.tests_passed ? 'pass' : 'fail'}  ${r.started_at}`,
        );
        if (r.result_text) console.log(`  ${r.result_text.trim().split('\n').slice(-6).join('\n  ')}`);
      }
      break;
    }

    case 'log': {
      const t = db.getTask(taskId(rest[0])) ?? die('no such task');
      const runs = db.runsForTask(t.id);
      const run = flags.attempt ? runs.find((r) => r.attempt === Number(flags.attempt)) : runs.at(-1);
      if (!run) die('no runs yet');
      if (flags.raw) process.stdout.write(readFileSync(run.log_path, 'utf8'));
      else printLog(run.log_path);
      break;
    }

    case 'goals': {
      if (!rest[0]) die('usage: agentdeck goals <repo> [--file goals.md]');
      if (flags.file) actions.updateRepo(db, rest[0], { goals: readFileSync(flags.file, 'utf8') });
      const r = actions.repoDetail(db, rest[0]);
      console.log(`# ${r.goals_path}\n`);
      console.log(r.goals.trim() || '(empty: write the outcomes you want, priorities, and what not to touch)');
      break;
    }

    case 'plan': {
      if (!rest[0]) die('usage: agentdeck plan <repo>');
      console.log(`planning ${rest[0]}…`);
      const res = await actions.planNow(db, rest[0]);
      console.log(`${res.outcome}${res.note ? `: ${res.note}` : ''}`);
      for (const t of res.tasks) console.log(fmtTask(t, repoName(t.repo_id)));
      for (const t of res.skipped) console.log(`  skipped (duplicate or over the cap): ${t}`);
      if (res.tasks.some((t) => t.status === 'proposed')) console.log('approve with `agentdeck approve <id>`');
      break;
    }

    case 'approve':
    case 'reject': {
      if (!rest.length) die(`usage: agentdeck ${cmd} <id>...`);
      for (const arg of rest) {
        const id = taskId(arg);
        (cmd === 'approve' ? actions.approveTask : actions.rejectTask)(db, id);
        console.log(`${cmd === 'approve' ? 'queued' : 'rejected'} #${id}`);
      }
      break;
    }

    case 'install': {
      const st = await service.install();
      console.log(`installed ${st.plist}`);
      console.log(`daemon ${st.state ?? 'loading'}${st.pid ? ` (pid ${st.pid})` : ''}; it starts at login and restarts if it dies`);
      console.log(`logs: ~/.agentdeck/logs/daemon.log · runs ${st.program}`);
      break;
    }

    case 'uninstall':
      await service.uninstall();
      console.log('removed the launchd agent; the daemon is stopped');
      break;

    case 'service': {
      const st = await service.serviceStatus();
      console.log(`installed  ${st.installed ? st.plist : 'no'}`);
      console.log(`loaded     ${st.loaded ? `${st.state ?? '?'}${st.pid ? `, pid ${st.pid}` : ''}` : 'no'}`);
      console.log(`program    ${st.program}`);
      break;
    }

    case 'cancel': {
      const id = taskId(rest[0]);
      console.log(actions.cancelTask(db, id) === 'cancelled' ? `cancelled #${id}` : `stopping #${id}…`);
      break;
    }

    case 'retry': {
      const id = taskId(rest[0]);
      actions.retryTask(db, id);
      console.log(`requeued #${id}`);
      break;
    }

    case 'clean': {
      const t = db.getTask(taskId(rest[0])) ?? die('no such task');
      if (t.status === 'running') die('task is running');
      if (!t.worktree) die('task has no worktree');
      await removeWorktree(db.getRepo(t.repo_id)!, t.worktree);
      db.updateTask(t.id, { worktree: null });
      console.log(`removed worktree; branch ${t.branch} kept`);
      break;
    }

    case 'pause':
      actions.setPaused(db, true);
      console.log('paused: running tasks finish, no new ones start');
      break;

    case 'resume':
      actions.setPaused(db, false);
      console.log('resumed');
      break;

    case 'set': {
      const [key, value = ''] = rest;
      const on = (v: string) => ['1', 'on', 'true', 'yes'].includes(v.toLowerCase());
      if (key === 'max_concurrent') actions.updateSettings(db, { max_concurrent: Number(value) });
      else if ((BUDGET_KEYS as string[]).includes(key)) actions.updateSettings(db, { budget: { [key]: Number(value) } });
      else if (key === 'notify_desktop') actions.updateSettings(db, { notify: { desktop: on(value) } });
      else if (key === 'notify_events')
        actions.updateSettings(db, { notify: { events: value.split(',').filter(Boolean) as NotifyKind[] } });
      else if (key === 'ntfy_topic' || key === 'ntfy_server') actions.updateSettings(db, { notify: { [key]: value } });
      else if (key === 'planner_enabled') actions.updateSettings(db, { planner: { enabled: on(value) } });
      else if (key === 'planner_interval_hours') actions.updateSettings(db, { planner: { interval_hours: Number(value) } });
      else if (key === 'planner_max_tasks') actions.updateSettings(db, { planner: { max_tasks: Number(value) } });
      else if (key === 'planner_model') actions.updateSettings(db, { planner: { model: value } });
      else die(`unknown setting "${key}"; see agentdeck help`);
      console.log(`${key} = ${value}`);
      break;
    }

    case 'settings': {
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
      break;
    }

    case 'notify-test':
      await actions.sendTestNotification(db);
      console.log('sent');
      break;

    case 'status': {
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
      break;
    }

    case 'daemon':
    case 'run-once': {
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
        const api = await startApi(db).catch((err) => {
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
      break;
    }

    default:
      die(`unknown command "${cmd}"\n\n${HELP}`);
  }
  db.close();
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof actions.ActionError) die(err.message);
  throw err;
}
