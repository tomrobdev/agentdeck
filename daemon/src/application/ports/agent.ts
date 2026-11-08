// The Agent port: runs one claude session and reports through callbacks. The real adapter is adapters/claude.ts
// (compose.ts); tests use the in-memory fake in test/fakes.ts. Every real session runs in its own process group.
import type { WriteStream } from 'node:fs';
import type { ClaudeRun, UsageWindow } from '../../domain/runs/index.ts';

/** One claude session to run. */
export interface AgentSession {
  args: string[];
  cwd: string;
  log: WriteStream;
  env?: Record<string, string>;
  shouldCancel?: () => boolean;
  /** Called with the pid (= process group id) so it can be recorded for crash recovery. */
  onSpawn?: (pid: number) => void;
  /** Called for each usage window the session reports. */
  onUsage?: (w: UsageWindow) => void;
  /** Called with each parsed event of the stream. */
  onEvent?: (ev: any) => void;
  /** Called once with the session id, so a run a restart ends can be resumed. */
  onSession?: (sessionId: string) => void;
  /** Called once with the exact model id the session's init names, so the run records what it ran on. */
  onModel?: (modelId: string) => void;
}

export interface Agent {
  /** Run a session to its end. */
  run(session: AgentSession): Promise<ClaudeRun>;
  /** Where the claude binary is, or null. */
  find(): Promise<string | null>;
}
