// The Agent port: runs one claude session and reports through callbacks.
import type { WriteStream } from 'node:fs';
import type { ClaudeRun, UsageWindow } from '#domain/runs/index.ts';

export interface AgentSession {
  args: string[];
  cwd: string;
  log: WriteStream;
  env?: Record<string, string>;
  shouldCancel?: () => boolean;
  onSpawn?: (pid: number) => void;
  onUsage?: (w: UsageWindow) => void;
  onEvent?: (ev: unknown) => void;
  onSession?: (sessionId: string) => void;
  onModel?: (modelId: string) => void;
}

export interface Agent {
  run(session: AgentSession): Promise<ClaudeRun>;
  find(): Promise<string | null>;
}
