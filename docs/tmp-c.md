- Parent.

  - `failIfUnavailable`: if the sandbox can't start, claude exits instead of running unsandboxed.
  - `allowUnsandboxedCommands: false`: claude can't retry a refused command outside the sandbox
    (`dangerouslyDisableSandbox` is ignored).
  - `strictAllowlist`: hosts outside `allowedDomains` are refused, with no prompt (there is nobody to answer one).
  - `permissions.allow`: the file tools (Edit, Write) run outside the sandbox, so they get rules for the
    worktree only. In permission rules, `//` marks an absolute path. A single `/` would be relative to the
    settings file, so the worker writes `/` followed by the absolute path. The bare `Edit` and `Write`
    rules are removed from `--allowedTools`, because they would allow any path.

- Next.
