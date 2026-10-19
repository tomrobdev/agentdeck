#!/bin/sh
# `pnpm dev`: use the launchd service daemon (installing it if needed) and start only the dashboard.
# Turn on `agentdeck set reload_on_change on` so the daemon picks up edits to daemon/src by itself.
set -eu
AGENTDECK="$PWD/daemon/bin/agentdeck.js"
if ! node "$AGENTDECK" service | grep -q '^installed  /'; then
  echo "installing the agentdeck service (runs the daemon from $PWD/daemon)"
  node "$AGENTDECK" install
elif node "$AGENTDECK" service | grep -q '^loaded     no'; then
  node "$AGENTDECK" service start
fi
exec pnpm dev:app
