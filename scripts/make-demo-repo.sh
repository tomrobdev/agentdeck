#!/bin/sh
# Create a tiny Node project to point AgentDeck at while testing.
# Usage: scripts/make-demo-repo.sh [path]   (default ~/.agentdeck/demo-repo)
set -eu
DIR="${1:-$HOME/.agentdeck/demo-repo}"
if [ -e "$DIR" ]; then echo "$DIR already exists" >&2; exit 1; fi
mkdir -p "$DIR/src" "$DIR/test"
cd "$DIR"

cat > package.json <<'EOF'
{
  "name": "agentdeck-demo",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test test/" }
}
EOF

cat > src/strings.js <<'EOF'
export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
EOF

cat > test/strings.test.js <<'EOF'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capitalize } from '../src/strings.js';

test('capitalize', () => {
  assert.equal(capitalize('hello'), 'Hello');
});
EOF

cat > README.md <<'EOF'
# agentdeck-demo

Scratch project for testing AgentDeck workers. `npm test` runs the tests.
EOF

git init -q -b main
# Workers commit in worktrees, so the repo needs an identity.
git config user.name >/dev/null || git config user.name "agentdeck"
git config user.email >/dev/null || git config user.email "agentdeck@localhost"
git add -A
git commit -q -m "Initial demo project"
echo "demo repo ready at $DIR"
