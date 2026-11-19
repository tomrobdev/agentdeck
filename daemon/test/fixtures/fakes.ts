// In-memory fakes of the Agent and CodeHost ports, for tests that need no `claude` binary and no `gh`:
import type { Agent, AgentSession } from '#application/ports/agent.ts';
import type { CodeHost } from '#application/ports/code-host.ts';
import type { BranchPr, CreatePr, PrDetails } from '#domain/landing/index.ts';
import type { ClaudeResult, ClaudeRun } from '#domain/runs/index.ts';

export interface FakeAgent extends Agent {
  sessions: AgentSession[];
}

export function fakeAgent(work: (session: AgentSession) => void | Promise<void> = () => {}, result: Partial<ClaudeResult> = {}): FakeAgent {
  const sessions: AgentSession[] = [];
  return {
    sessions,
    find: async () => '/fake/claude',
    async run(session) {
      sessions.push(session);
      const id = `fake-session-${sessions.length}`;
      session.onSession?.(id);
      const model = session.args.includes('--model') ? session.args[session.args.indexOf('--model') + 1] : undefined;
      if (model) session.onModel?.(model.startsWith('claude-') ? model : `claude-${model}-5-5`);
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

export const READY_PR: PrDetails = {
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  merge_state: 'CLEAN',
  body: '## Merge Danger\n\nDoor: two-way',
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
  merge_commit: null,
  paths: ['src/a.ts'],
  labels: [],
};

export interface FakeCodeHost extends CodeHost {
  details: Record<string, PrDetails>;
  branchPrs: Record<string, BranchPr[]>;
  created: CreatePr[];
  pushed: { repoPath: string; branch: string }[];
  merged: { url: string; method: string; head: string }[];
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
    jobSteps: async () => [],
    jobStart: async () => ({ job: { runner_name: 'GitHub Actions 1', steps: 3 }, annotations: [] }),
    markReady: async () => {},
    merge: async (pr) => void host.merged.push({ url: pr.url, method: pr.method, head: pr.head }),
    deleteRemoteBranch: async (_repoPath, branch) => void host.deletedBranches.push(branch),
  };
  return host;
}
