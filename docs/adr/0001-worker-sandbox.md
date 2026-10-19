# ADR 0001: Run worker shell commands in Claude Code's sandbox

Status: accepted, 2026-10-18

## Context

Workers run `claude -p --permission-mode dontAsk` with an allow list of tool rules. The rules decide which
commands may _start_, not what those commands then do. Rules such as `Bash(node *)` and `Bash(pnpm run *)`
let a worker run any code: it writes a `.mjs` file or a `package.json` script, then runs it. So "no network,
no push, stay in the worktree" was only a convention. `Bash(git push*)` in the disallowed tools stops the
literal command, not `node -e` doing the same thing.

## Options considered

1. **Tighter tool rules.** Drop `node *` and `pnpm run *`. Breaks most repos' test and build scripts, and
   every allowed interpreter is still a way out. Rejected.
2. **A container or VM per run.** Strong isolation, but it needs Docker or a VM image on the user's Mac and
   repo toolchains inside it. It would be a large new runtime dependency. Rejected for now.
3. **Wrap `claude` in `sandbox-exec` ourselves.** We would have to write and maintain Seatbelt profiles,
   a network proxy and the git-worktree exceptions. Claude Code already ships all of this.
4. **Claude Code's built-in Bash sandbox** (Seatbelt on macOS, `@anthropic-ai/sandbox-runtime`). The OS
   confines every Bash command and its children. Writes may go only to the working directory (plus the
   shared `.git` of a linked worktree, without its `hooks/` and `config`) and the temp dir. Network goes
   through a proxy that checks an allow list. **Chosen.**

## Decision

- For each run the worker writes `<log dir>/task-<id>-attempt-<n>.settings.json`. It goes next to the run
  log, outside the worktree, so the agent cannot edit it. The worker passes it with `--settings <file>`
  (`application/tools.ts` `runSettings`; the content comes from the pure `domain/run/sandbox.ts` `workerSettings`):

  ```json
  {
    "sandbox": {
      "enabled": true,
      "failIfUnavailable": true,
      "allowUnsandboxedCommands": false,
      "network": { "allowedDomains": ["<repos.network>"], "strictAllowlist": true }
    },
    "permissions": { "allow": ["Edit(//<worktree>/**)"] }
  }
  ```

  - `failIfUnavailable`: if the sandbox can't start, claude exits instead of running unsandboxed.
  - `allowUnsandboxedCommands: false`: claude can't retry a refused command outside the sandbox
    (`dangerouslyDisableSandbox` is ignored).
  - `strictAllowlist`: hosts outside `allowedDomains` are refused, with no prompt (there is nobody to answer one).
  - `permissions.allow`: the file tools (Edit, Write) run outside the sandbox, so they get rules for the
    worktree only. In permission rules, `//` marks an absolute path. A single `/` would be relative to the
    settings file, so the worker writes `/` followed by the absolute path. The bare `Edit` and `Write`
    rules are removed from `--allowedTools`, because they would allow any path.

- `Bash(git push*)`, `Bash(git remote*)` and `Bash(rm -rf*)` stay in `--disallowedTools` as an extra block.

- New migration step 6 adds two columns: `repos.network`, a JSON array of hosts (default `[]`, no network),
  and `repos.sandbox`, `INTEGER NOT NULL DEFAULT 1`. Set them with
  `agentdeck repo set <repo> network "registry.npmjs.org,github.com"` and `agentdeck repo set <repo> sandbox on|off`. With the sandbox off,
  the settings file has `sandbox.enabled: false` but keeps the worktree-only file rules.

- `setup_cmd` and `test_cmd` run in the daemon, outside the sandbox, so `pnpm install` and similar commands
  still have the network. The planner is unchanged. Its tools are read-only (Read, Glob, Grep, and
  `git log`/`show`/`diff`, `ls`, `cat`), with no interpreter and no Edit or Write, so it has no way to
  run code of its own.

- If claude exits without a result (the sandbox couldn't start, for example), the last line of its stderr
  is added to the run's failure reason (`claude exited with code 1: <stderr>`). That reason is stored as
  the task's `blocked_reason` and shown in `agentdeck ls` and in notifications.

### Minimum Claude Code version: v2.1.285

The sandboxing docs say that from v2.1.285, `false` values and `strictAllowlist` given with `--settings`
hold against a repository's own `.claude/settings.json`. Before that version, a project's `true` overrode
a `false` in user settings, and any settings file could change the proxy ports. A repo under work could
then widen its own sandbox. The other keys (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`,
`network.allowedDomains`, the worktree `.git` exception) are older.

**Not verified:** `claude --version` wasn't allowed in the worktree where this was written, so I couldn't
check the installed version. The reviewer should run it and confirm the version is ≥ 2.1.285. A follow-up
could add this to `agentdeck repo doctor`.

## Consequences

- An agent can no longer reach the network or write outside its worktree through Bash. That includes
  scripts it writes itself. This holds only if Claude Code's sandbox holds; the extra block on
  `git push` stays in place either way.
- A repo whose tests need the network (a test that calls an API) fails under the sandbox until its hosts are
  added to `repos.network`. A repo whose tooling can't run sandboxed at all (Docker, some watchers) needs
  `sandbox off`, which brings back the old, convention-only limits for that repo.
- Tools that ignore the `HTTP(S)_PROXY` variables (plain `ssh`, database drivers, UDP) can't connect even
  to allowed hosts.
- When the sandbox can't start, every run of every repo fails with the same reason until it is fixed.
  Retries fail the same way.
- Read, Glob and Grep are not limited to the worktree, so the agent can still read files elsewhere on the
  machine. The sandbox blocks network exfiltration from Bash, but the file tools still run outside it.

## Manual checks for the reviewer

The tests use a fake `claude`. They check the arguments, the settings file content (sandbox on, sandbox off,
with a network list), the `--settings` path the fake gets, and that a startup failure's stderr becomes the
failure reason. These checks need the real `claude` (≥ 2.1.285) on macOS. Run each one as a one-off task
in a scratch repo with the default settings (sandbox on, `network` empty):

1. `claude --version` reports ≥ 2.1.285.
2. A sandboxed `node -e "fetch('https://example.com').then(r => console.log(r.status))"` fails with a
   network or proxy error instead of printing `200`.
3. After `agentdeck repo set <repo> network example.com`, the same command prints `200`.
4. A Bash write outside the worktree, `node -e "require('fs').writeFileSync(process.env.HOME + '/agentdeck-escape.txt', 'x')"`,
   is refused (`EPERM`), and `~/agentdeck-escape.txt` doesn't exist.
5. The Write tool aimed at a path outside the worktree (e.g. `~/agentdeck-escape.txt`) is refused and
   counted in the run's `denials`.
6. `git add` and `git commit` inside the worktree still work: the sandbox allows the linked worktree's shared `.git`.
7. With `sandbox.failIfUnavailable` and the sandbox forced to fail (e.g. a fake `sandbox-exec` earlier on `PATH`),
   the task ends `failed` and its reason shows claude's startup error, not only an exit code.
8. With `agentdeck repo set <repo> sandbox off`, check 2 succeeds again, and check 5 is still refused.
9. If the worktree path contains a symlink (e.g. `AGENTDECK_HOME` under `/tmp`, which is `/private/tmp`),
   confirm the `Edit(//…)` rules still match. If they don't, the worker should write the `realpath`.
