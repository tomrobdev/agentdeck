import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as actions from './actions.ts';
import { startApi } from './api.ts';
import { API_PORT, DB_PATH, DEFAULTS } from './config.ts';
import { type Task, type TaskStatus, openDb } from './db.ts';
import { removeWorktree } from './git.ts';
import { Scheduler } from './scheduler.ts';

const HELP = `agentdeck: always-on Claude Code task queue

Repos
  agentdeck repo add <path> [--name n] [--base main] [--test "npm test"] [--tools "Read,Edit,Bash(npm *)"]
  agentdeck repo ls

Tasks
  agentdeck add "<prompt>" --repo <name> [--title t] [--priority n] [--model sonnet] [--max-turns n] [--attempts n]
  agentdeck ls [--status queued|running|done|blocked|failed|cancelled]
  agentdeck show <id>
  agentdeck log <id> [--attempt n] [--raw]
  agentdeck cancel <id>
  agentdeck retry <id>
  agentdeck clean <id>          remove the task's worktree (its branch is kept)

Daemon
  agentdeck daemon              run the scheduler in the foreground
  agentdeck run-once            work the queue until empty, then exit (ignores pause)
  agentdeck pause | resume
  agentdeck status
  agentdeck set max_concurrent <n>
`;

const STATUS_ICON: Record<TaskStatus, string> = {
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

function fmtTask(t: Task, repoName: string): string {
  const extra = t.blocked_reason && (t.status === 'blocked' || t.status === 'failed') ? `  — ${t.blocked_reason}` : '';
  return `${STATUS_ICON[t.status]} #${String(t.id).padEnd(4)} ${t.status.padEnd(9)} p${t.priority}  ${repoName.padEnd(14)} ${t.title}${extra}`;
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
      tools: { type: 'string' },
      repo: { type: 'string', short: 'r' },
      title: { type: 'string', short: 't' },
      priority: { type: 'string', short: 'p' },
      model: { type: 'string', short: 'm' },
      'max-turns': { type: 'string' },
      attempts: { type: 'string' },
      status: { type: 'string', short: 's' },
      attempt: { type: 'string' },
      raw: { type: 'boolean' },
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
          tools: flags.tools?.split(',').map((t) => t.trim()),
        });
        console.log(`added repo "${repo.name}" (${repo.path}, base ${repo.base_branch}${repo.test_cmd ? `, tests: ${repo.test_cmd}` : ''})`);
      } else if (sub === 'ls' || !sub) {
        for (const r of db.listRepos()) console.log(`${r.name.padEnd(16)} ${r.path}  base=${r.base_branch}  test=${r.test_cmd ?? '-'}`);
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
      });
      console.log(`queued task #${t.id} on ${repoName(t.repo_id)} (${t.model}, ${t.max_turns} turns max)`);
      if (db.isPaused()) console.log('note: the daemon is paused; run `agentdeck resume` to start working');
      break;
    }

    case 'ls': {
      const tasks = db.listTasks(flags.status as TaskStatus | undefined);
      if (!tasks.length) console.log('no tasks');
      for (const t of tasks) console.log(fmtTask(t, repoName(t.repo_id)));
      break;
    }

    case 'show': {
      const t = db.getTask(taskId(rest[0])) ?? die('no such task');
      console.log(fmtTask(t, repoName(t.repo_id)));
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
      const [key, value] = rest;
      if (key !== 'max_concurrent' || !Number(value)) die('usage: agentdeck set max_concurrent <n>');
      db.setSetting(key, value);
      console.log(`${key} = ${value}`);
      break;
    }

    case 'status': {
      const st = actions.status(db);
      const limited = st.rate_limited_until && st.rate_limited_until * 1000 > Date.now();
      console.log(`state      ${st.paused ? 'PAUSED' : 'active'}${limited ? ` (rate limited, resumes in ${relTime(st.rate_limited_until!)})` : ''}`);
      console.log(`slots      ${st.running}/${st.max_concurrent} running`);
      console.log(`tasks      ${Object.entries(st.counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
      for (const w of st.usage) {
        console.log(`usage      ${w.window.padEnd(10)} ${(w.utilization * 100).toFixed(0).padStart(3)}%  resets in ${relTime(w.resets_at)}  (seen ${w.observed_at} UTC)`);
      }
      console.log(`db         ${DB_PATH}`);
      break;
    }

    case 'daemon':
    case 'run-once': {
      const once = cmd === 'run-once';
      const scheduler = new Scheduler(db, { once });
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.on(sig, () => {
          console.log(`${sig}: stopping workers; their tasks will be requeued on next start`);
          scheduler.stop();
          process.exit(0);
        });
      }
      if (!once) {
        const api = await startApi(db);
        console.log(`api        http://127.0.0.1:${API_PORT}`);
        process.on('exit', () => api.close());
      }
      console.log(`agentdeck ${once ? 'run-once' : 'daemon'}: ${db.isPaused() && !once ? 'PAUSED (agentdeck resume to start)' : 'active'}, max ${db.maxConcurrent()} concurrent, tick ${DEFAULTS.tickMs / 1000}s`);
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
