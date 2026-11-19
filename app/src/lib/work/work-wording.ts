// How the dashboard words what a task waits for, a list of tasks and the size of a changed file.
import type { StartWait } from '#api/types.ts';
import { oneLine } from '#daemon/domain/shared/index.ts';
import { relTime, when } from '#lib/shared/time.ts';

export function describeWait(h: StartWait): string {
  switch (h.kind) {
    case 'daemon-paused':
      return 'AgentDeck is paused';
    case 'rate-limited':
      return `Claude rate-limited us; resumes ${relTime(h.until)}`;
    case 'governor':
      return `On hold for the usage budget: ${h.reason}${h.until ? `; lifts around ${when(h.until)}` : ''}`;
    case 'repo-paused':
      return `The repo is paused: ${oneLine(h.reason)}`;
    case 'draining':
      return h.repo
        ? 'The repo is draining: it finishes the work in flight, then pauses'
        : 'AgentDeck is draining: it finishes the work in flight, then pauses';
    case 'dependency':
      return h.stuck ? `Can't start: ${h.stuck}` : `Waits for ${h.on.map((id) => `#${id}`).join(', ')} to finish`;
    case 'plan-branch':
      return `Waits: ${h.name} conflicts with ${h.base}; it starts once a merge of ${h.base} into it is pushed`;
    case 'unblocking':
      return 'Waits for its unblock run to stop';
    case 'slots':
      return `Waiting for a free slot (${h.running} of ${h.max} in use)`;
  }
}

export function taskList(ids: number[]): string {
  const tags = ids.map((id) => `#${id}`);
  return tags.length < 2 ? tags.join('') : `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1]}`;
}

export function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}
