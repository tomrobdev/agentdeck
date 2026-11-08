// In-memory fakes of the Agent and CodeHost ports, for tests that need no `claude` binary and no `gh`:
// `testApp(db, { agent: fakeAgent(), codeHost: fakeCodeHost() })`. The end-to-end tests (`e2e.test.ts`) keep the real
// adapters, on the fake claude binary, so the real process path stays covered.
import type { Agent, AgentSession } from '../src/application/ports/agent.ts';
import type { CodeHost } from '../src/application/ports/code-host.ts';
import type { BranchPr, CreatePr, PrDetails } from '../src/domain/landing/index.ts';
import type { ClaudeResult, ClaudeRun } from '../src/domain/runs/index.ts';

/** A fake agent and the sessions it was asked to run. */
export interface FakeAgent extends Agent {
  sessions: AgentSession[];
}

/**
 * An agent that "runs" by calling `work` (which may edit the session's worktree) and then ends with `result`, which
 * says `STATUS: DONE` unless a test gives another. It writes the result line to the log, as claude does.
 */
export function fakeAgent(work: (session: AgentSession) => void | Promise<void> = () => {}, result: Partial<ClaudeResult> = {}): FakeAgent {
  const sessions: AgentSession[] = [];
  return {
    sessions,
    find: async () => '/fake/claude',
    async run(session) {
      sessions.push(session);
      const id = `fake-session-${sessions.length}`;
      session.onSession?.(id);
      await work(session);
      const end: ClaudeResult = {
        subtype: 'success',
        result: 'Done.\nSTATUS: DONE',
        session_id: id,
        num_turns: 1,
        total_cost_usd: 0.01,
        ...result,
      };
      session.log.write(JSON.stringify({ type: 'result', ...end }) + '\n');
      const run: ClaudeRun = { result: end, exitCode: 0, rateLimitedUntil: undefined, cancelled: false, stderr: '', sessionId: id };
      return run;
    },
  };
}

/**
 * A pull request that is open, clean and ready to merge, with every field `parsePrDetails` reads from real `gh pr view`
 * output (contracts.test.ts checks it against daemon/test/fixtures/gh/).
 */
export const READY_PR: PrDetails = {
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  merge_state: 'CLEAN',
  commits: 1,
  files: 1,
  additions: 10,
  deletions: 2,
  checks: { total: 1, failing: 0, pending: 0 },
  check_list: [
    {
      name: 'check',
      state: 'pass',
      url: 'https://github.com/owner/repo/actions/runs/1/job/1',
      started_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T00:02:00Z',
    },
  ],
  head: '0000000000000000000000000000000000000001',
  paths: ['src/a.ts'],
  labels: [],
};

/**
 * A fake code host: what each pull request looks like (`details`, by url), the PRs GitHub lists for a branch (`branchPrs`, by
 * branch; it does not list the ones `createPr` made), and a record of what was done to them.
 */
export interface FakeCodeHost extends CodeHost {
  details: Record<string, PrDetails>;
  branchPrs: Record<string, BranchPr[]>;
  created: CreatePr[];
  pushed: { repoPath: string; branch: string }[];
  merged: { url: string; method: string }[];
  closed: string[];
  deletedBranches: string[];
}

export function fakeCodeHost(): FakeCodeHost {
  const host: FakeCodeHost = {
    details: {},
    branchPrs: {},
    created: [],
    pushed: [],
    merged: [],
    closed: [],
    deletedBranches: [],
    auth: async () => ({ ok: true, output: 'Logged in' }),
    push: async (repoPath, branch) => void host.pushed.push({ repoPath, branch }),
    createPr: async (pr) => {
      host.created.push(pr);
      return `https://example.test/pull/${host.created.length}`;
    },
    prsForBranch: async (_cwd, branch) => host.branchPrs[branch] ?? [],
    ensureLabel: async () => {},
    setLabel: async () => {},
    closePr: async (url) => void host.closed.push(url),
    prDetails: async (url) => host.details[url] ?? READY_PR,
    failedLog: async () => '',
    markReady: async () => {},
    merge: async (pr) => void host.merged.push({ url: pr.url, method: pr.method }),
    deleteRemoteBranch: async (_repoPath, branch) => void host.deletedBranches.push(branch),
  };
  return host;
}
