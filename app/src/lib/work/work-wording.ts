// How the dashboard words what a task waits for, a list of tasks and the size of a changed file.
import type { StartWait } from '../../api/types.ts';
import { oneLine } from '../../../../daemon/src/domain/shared/index.ts';
import { relTime, when } from '../shared/time.ts';

/** What a queued task waits for, in a few words, for chips and callouts. */
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
    case 'dependency':
      return h.stuck ? `Can't start: ${h.stuck}` : `Waits for ${h.on.map((id) => `#${id}`).join(', ')} to finish`;
    case 'unblocking':
      return 'Waits for its unblock run to stop';
    case 'slots':
      return `Waiting for a free slot (${h.running} of ${h.max} in use)`;
  }
}

/** "#80", "#80 and #81", "#80, #81 and #82". */
export function taskList(ids: number[]): string {
  const tags = ids.map((id) => `#${id}`);
  return tags.length < 2 ? tags.join('') : `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1]}`;
}

/** A size in bytes: "812 B", "14 KB". */
export function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}
