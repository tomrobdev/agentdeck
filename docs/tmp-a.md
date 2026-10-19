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
