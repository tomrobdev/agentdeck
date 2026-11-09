// What the command palette lists and in which order. What a person may do with a task is the daemon's personEvents and the
// stage.ts review and merge rules; this file only turns that into rows. Pure, so the daemon's tests can import it
// (daemon/test/palette.test.ts).
import type { TaskSummary } from '../../../../daemon/src/api/contract.ts';
import { FILTER_STATES, personEvents } from '../../../../daemon/src/domain/work/index.ts';
import { CHECKED_STATUSES, canStartMerge, isReview } from '../../../../daemon/src/domain/work/index.ts';
import { rank } from './fuzzy.ts';
import { type BulkAction, bulkActions } from '../queue/bulk.ts';
import { type EditRequest, GO_KEYS, type GoTarget, PRIORITY_KEYS, keyCaps } from './hotkeys.ts';

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
  /** Go to a place, as `g` then a key does. */
  go: (to: GoTarget) => void;
  /** Open the sheet of keys. */
  showKeys: () => void;
  /** Show the queue filtered to these states. */
  showStates: (states: string[]) => void;
  /** An edit key's edit, on the picked tasks or else the selected one. */
  edit: (request: EditRequest) => void;
  /** A bulk action on the picked tasks. */
  bulk: (action: BulkAction) => void;
}

export interface PaletteInput {
  tasks: readonly PaletteTask[];
  selected: PaletteTask | null;
  /** The picked tasks, whole, so the bulk actions are the ones every one of them allows. */
  picked?: readonly TaskSummary[];
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

const BULK_LABEL: Record<BulkAction, string> = { approve: 'Approve', reject: 'Reject', retry: 'Retry', merge: 'Merge', cancel: 'Cancel' };
const BULK_KEY: Partial<Record<BulkAction, string>> = { approve: 'a', retry: 'r', merge: 'm' };
const plural = (n: number) => `${n} picked task${n === 1 ? '' : 's'}`;

/** The bulk actions every picked task allows, then the edits: first in the list, as the selected task's own actions are. */
function pickedActions(picked: readonly TaskSummary[], h: PaletteHandlers): PaletteItem[] {
  const mine = (key: string, label: string, run: () => void, shortcut?: string): PaletteItem => ({
    key: `picked:${key}`,
    label,
    shortcut,
    kind: 'command',
    forSelected: true,
    fields: [label],
    run,
  });
  return [
    ...bulkActions([...picked]).map((a) => mine(a, `${BULK_LABEL[a]} ${plural(picked.length)}`, () => h.bulk(a), BULK_KEY[a])),
    ...editCommands(h, plural(picked.length), true).map((i) => ({ ...i, key: `picked:${i.key}`, forSelected: true })),
  ];
}

/** The edit keys as commands. `target` names who is edited ("#5" or "2 picked tasks"). */
function editCommands(h: PaletteHandlers, target: string, many: boolean): PaletteItem[] {
  const edit = (key: string, label: string, request: EditRequest, shortcut: string): PaletteItem => ({
    key: `edit:${key}`,
    label: `${label} (${target})`,
    shortcut,
    kind: 'command',
    forSelected: false,
    fields: [`${label} ${target}`, label],
    run: () => h.edit(request),
  });
  return [
    // A prompt is one task's.
    ...(many ? [] : [edit('prompt', 'Edit the prompt', { kind: 'prompt' }, 'e')]),
    ...PRIORITY_KEYS.map(({ key, level, label }) =>
      edit(`priority-${level}`, `Set priority ${label.toLowerCase()}`, { kind: 'priority', level }, `p ${key}`),
    ),
    edit('model', 'Set the model', { kind: 'model' }, 'M'),
    edit('link', 'Link to another task', { kind: 'link' }, 'l'),
  ];
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
export function paletteItems({ tasks, selected, picked = [], paused, handlers: h }: PaletteInput): PaletteItem[] {
  const items: PaletteItem[] = picked.length ? pickedActions(picked, h) : selected ? selectedActions(selected, h) : [];
  // The edits come after the other commands, still matched by the selected task's "#id".
  const edits = !picked.length && selected ? editCommands(h, `#${selected.id}`, false) : [];
  items.push(
    command('new', 'New task', h.newTask, 'c'),
    command('pause', paused ? 'Resume the daemon' : 'Pause the daemon', h.togglePause),
    command('restart', 'Restart the daemon', h.restartDaemon),
    command('view-list', 'Show list', () => h.view('list')),
    command('view-board', 'Show board', () => h.view('board')),
    command('view-graph', 'Show graph', () => h.view('graph')),
    command('theme', 'Toggle light and dark', h.toggleTheme),
    ...FILTER_STATES.map((s) => command(`show-${s.key}`, `Show ${s.label.toLowerCase()}`, () => h.showStates([s.key]))),
    ...GO_KEYS.map((g) => command(`go-${g.to}`, g.label, () => h.go(g.to), keyCaps(g.key).join(' then '))),
    command('keys', 'Show keyboard shortcuts', h.showKeys, '?'),
  );
  items.push(...edits);
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
