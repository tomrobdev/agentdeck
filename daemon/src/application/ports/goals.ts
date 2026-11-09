// The Goals port: each repo's goals file, read by the planner. The real adapter is adapters/local/goals.ts (compose.ts);
// tests run it on real files under AGENTDECK_HOME.
import type { Repo } from '../../domain/repos/index.ts';

type Named = Pick<Repo, 'name'>;

export interface Goals {
  /** Where the repo's goals file is, whether or not it exists yet. */
  path(repo: Named): string;
  /** The goals, or '' when there is no file. */
  read(repo: Named): string;
  write(repo: Named, text: string): void;
  delete(repo: Named): void;
}
