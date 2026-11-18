// How the dashboard names a repo's settings.
import type { PrMode } from '#api/types.ts';
import { PR_MODES } from '#daemon/domain/repos/index.ts';

const PR_MODE_WORDS: Record<PrMode, { label: string; title: string }> = {
  off: { label: 'Off', title: 'Keep the work on its branch; open no pull request' },
  draft: { label: 'Draft', title: 'Push and open a draft pull request when a task is done' },
  ready: { label: 'Ready', title: 'Push and open a pull request ready for review when a task is done' },
};

export const PR_MODE_OPTIONS = PR_MODES.map((value) => ({ value, ...PR_MODE_WORDS[value] }));
