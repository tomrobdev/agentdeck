// The Goals port: each repo's goals file, read by the planner.
import type { Repo } from '#domain/repos/index.ts';

type Named = Pick<Repo, 'name'>;

export interface Goals {
  path(repo: Named): string;
  read(repo: Named): string;
  write(repo: Named, text: string): void;
  delete(repo: Named): void;
}
