// What the command palette lists and in which order. What a person may do with a task is the daemon's personEvents and the
// stage.ts review and merge rules; this file only turns that into rows. Pure, so the daemon's tests can import it
// (daemon/test/palette.test.ts).
import type { TaskSummary } from '../../../daemon/src/api/contract.ts';
import { personEvents } from '../../../daemon/src/domain/work/index.ts';
import { CHECKED_STATUSES, canStartMerge, isReview } from '../../../daemon/src/domain/work/index.ts';
import { rank } from './fuzzy.ts';

export type PaletteTask = Pick<TaskSummary, 'id' | 'title' | 'status' | 'pr_state' | 'sync' | 'merge_request'> & {
  repo?: string | null;
  branch?: string | null;
};
export type ViewMode = 'list' | 'board' | 'graph';

/** What the palette can do. The app supplies these; the palette never calls the API itself. */
export interface PaletteHandlers {
  open: (id: number) => void;
  act: (kind: 'approve' | 'retry' | 'cancel' | 'mark_done', id: number) => void;
  merge: (id: number) => void;
  /** Start a verify run on a proposed or queued task. */
  verify: (id: number) => void;
  /** Copy the task's agentdeck:// link. */
  copyLink: (id: number) => void;
  newTask: () => void;
  togglePause: () => void;
  restartDaemon: () => void;
  view: (mode: ViewMode) => void;
  toggleTheme: () => void;
}

export interface PaletteInput {
  tasks: readonly PaletteTask[];
  selected: PaletteTask | null;
  paused: boolean;
  handlers: PaletteHandlers;
}

export interface PaletteItem {
  key: string;
  /** What the row says. */
  label: string;
  /** Dimmer text after the label: a task's repo and status. */
  detail?: string;
  /** The key that does this outside the palette, where there is one. */
  shortcut?: string;
  kind: 'task' | 'command';
  /** True for the selected task's own actions, which come first. */
  forSelected: boolean;
  /** What the query is matched against. */
  fields: string[];
  run: () => void;
}

/** The selected task's actions, in the order a person most likely wants them. */
function selectedActions(t: PaletteTask, h: PaletteHandlers): PaletteItem[] {
  const events = personEvents(t);
  const mine = (key: string, label: string, run: () => void, shortcut?: string): PaletteItem => ({
    key: `selected:${key}`,
    label: `${label} #${t.id}`,
    detail: t.title,
    shortcut,
    kind: 'command',
    forSelected: true,
    fields: [`${label} #${t.id}`, label, t.title],
    run,
  });
  const out: PaletteItem[] = [];
  if (canStartMerge(t)) out.push(mine('merge', 'Merge', () => h.merge(t.id), 'm'));
  if (events.includes('approve')) out.push(mine('approve', 'Approve', () => h.act('approve', t.id), 'a'));
  // A verify run checks the prompt's claims about the code before the task starts.
  if (CHECKED_STATUSES.includes(t.status)) out.push(mine('verify', 'Verify', () => h.verify(t.id)));
  // A task in review is sent back with a note, from its page; a plain retry is for work that went wrong.
  if (events.includes('retry') && !isReview(t)) out.push(mine('retry', 'Retry', () => h.act('retry', t.id), 'r'));
  if (events.includes('mark_done')) out.push(mine('mark_done', 'Mark done', () => h.act('mark_done', t.id)));
  if (events.includes('cancel')) out.push(mine('cancel', t.status === 'running' ? 'Stop' : 'Cancel', () => h.act('cancel', t.id)));
  out.push(mine('open', 'Open task', () => h.open(t.id), '↵'));
  out.push(mine('copy-link', 'Copy link to', () => h.copyLink(t.id)));
  return out;
}

const command = (key: string, label: string, run: () => void, shortcut?: string): PaletteItem => ({
  key: `command:${key}`,
  label,
  shortcut,
  kind: 'command',
  forSelected: false,
  fields: [label],
  run,
});

/** Every row the palette can show, before the query. */
export function paletteItems({ tasks, selected, paused, handlers: h }: PaletteInput): PaletteItem[] {
  const items: PaletteItem[] = selected ? selectedActions(selected, h) : [];
  items.push(
    command('new', 'New task', h.newTask, 'c'),
    command('pause', paused ? 'Resume the daemon' : 'Pause the daemon', h.togglePause),
    command('restart', 'Restart the daemon', h.restartDaemon),
    command('view-list', 'Show list', () => h.view('list')),
    command('view-board', 'Show board', () => h.view('board')),
    command('view-graph', 'Show graph', () => h.view('graph')),
    command('theme', 'Toggle light and dark', h.toggleTheme),
  );
  for (const t of tasks) {
    items.push({
      key: `task:${t.id}`,
      label: `#${t.id} ${t.title}`,
      detail: [t.repo, t.status].filter(Boolean).join(' · '),
      kind: 'task',
      forSelected: false,
      fields: [`#${t.id}`, t.title, t.repo ?? '', t.branch ?? ''],
      run: () => h.open(t.id),
    });
  }
  return items;
}

/** Selected-task actions outrank other matches, but not an exact "#id". */
const SELECTED_BONUS = 500;

/** The rows that match `query`, best first. With no query: the selected task's actions, then commands, then tasks. */
export function searchPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  return rank(
    items,
    query,
    (i) => i.fields,
    (i) => (i.forSelected ? SELECTED_BONUS : 0),
  );
}
