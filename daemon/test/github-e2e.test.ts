// pnpm test:github (daemon/scripts/github-e2e.mjs) is opt-in: it refuses to run, before it touches GitHub, without a
// throwaway repo to run on. The run itself needs GitHub, so a person runs it (docs/github-e2e.md).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SCRIPT = join(import.meta.dirname, '../scripts/github-e2e.mjs');

/**
 * Run the script with `repo` as AGENTDECK_GITHUB_E2E_REPO (unset when undefined), and gh logged in nowhere: no token, and
 * an empty config folder.
 */
function runScript(repo: string | undefined) {
  const { AGENTDECK_GITHUB_E2E_REPO: _repo, GH_TOKEN: _gh, GITHUB_TOKEN: _github, ...env } = process.env;
  const config = mkdtempSync(join(tmpdir(), 'agentdeck-gh-config-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT], {
      env: { ...env, GH_CONFIG_DIR: config, ...(repo === undefined ? {} : { AGENTDECK_GITHUB_E2E_REPO: repo }) },
      encoding: 'utf8',
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
}

/** The owner/name of this checkout's GitHub origin, or null. */
function ownOrigin(): string | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

test('test:github refuses to run without AGENTDECK_GITHUB_E2E_REPO', () => {
  const { code, out } = runScript(undefined);
  assert.equal(code, 2);
  assert.match(out, /refused to run: AGENTDECK_GITHUB_E2E_REPO is not set/);
  assert.match(out, /docs\/github-e2e\.md/);
});

test('test:github refuses a repo that is not owner/name', () => {
  const { code, out } = runScript('not a repo');
  assert.equal(code, 2);
  assert.match(out, /must be owner\/name, got "not a repo"/);
});

test("test:github refuses this checkout's own origin, whose main its reset would force-push", (t) => {
  const own = ownOrigin();
  if (!own) return t.skip('this checkout has no GitHub origin');
  const { code, out } = runScript(own.toUpperCase());
  assert.equal(code, 2);
  assert.match(out, /is this checkout's origin/);
});

test('test:github refuses to run without a logged-in gh', () => {
  const { code, out } = runScript('someone/throwaway-e2e');
  assert.equal(code, 2);
  assert.match(out, /gh is not logged in \(or not installed\)/);
});
