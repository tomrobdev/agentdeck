#!/bin/sh
# `pnpm dev`: use the launchd service daemon (installing it if needed) and start only the dashboard.
# Turn on `agentdeck set reload_on_change on` so the daemon picks up edits to daemon/src by itself.
set -eu
AGENTDECK="$PWD/daemon/bin/agentdeck.js"
# Install only when the service says it isn't: a reinstall restarts the daemon and interrupts its runs.
STATUS=$(node "$AGENTDECK" service)
if printf '%s\n' "$STATUS" | grep -Eq '^installed +no$'; then
  echo "installing the agentdeck service (runs the daemon from $PWD/daemon)"
  node "$AGENTDECK" install
elif printf '%s\n' "$STATUS" | grep -Eq '^loaded +no$'; then
  node "$AGENTDECK" service start
fi
exec pnpm dev:app
