import type { TaskSummary } from '../../../../daemon/src/api/contract/work.ts';
import { FILTER_STATES, personEvents } from '../../../../daemon/src/domain/work/index.ts';
import { CHECKED_STATUSES, canStartMerge, isReview } from '../../../../daemon/src/domain/work/index.ts';
import { rank } from '../shared/fuzzy.ts';
import { type BulkAction, bulkActions } from './queue/bulk.ts';
import { type EditRequest, GO_KEYS, type GoTarget, PRIORITY_KEYS, keyCaps } from '../shared/hotkeys.ts';

export type PaletteTask = Pick<TaskSummary, 'id' | 'title' | 'status' | 'pr_state' | 'sync' | 'merge_request'> & {
  repo?: string | null;
  branch?: string | null;
};
export type ViewMode = 'list' | 'board' | 'graph';

export interface PaletteHandlers {
  open: (id: number) => void;
  act: (kind: 'approve' | 'retry' | 'cancel' | 'mark_done', id: number) => void;
  merge: (id: number) => void;
  verify: (id: number) => void;
  copyLink: (id: number) => void;
  newTask: () => void;
  togglePause: () => void;
  restartDaemon: () => void;
  view: (mode: ViewMode) => void;
  toggleTheme: () => void;
  goTo: (to: GoTarget) => void;
  showKeys: () => void;
  showStates: (states: string[]) => void;
  edit: (request: EditRequest) => void;
  bulk: (action: BulkAction) => void;
}

export interface PaletteInput {
  tasks: readonly PaletteTask[];
  selected: PaletteTask | null;
  picked?: readonly TaskSummary[];
  paused: boolean;
  handlers: PaletteHandlers;
}

export interface PaletteItem {
  key: string;
  label: string;
  detail?: string;
  shortcut?: string;
  kind: 'task' | 'command';
  forSelected: boolean;
  fields: string[];
  run: () => void;
}

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
  if (CHECKED_STATUSES.includes(t.status)) out.push(mine('verify', 'Verify', () => h.verify(t.id)));
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

export function paletteItems({ tasks, selected, picked = [], paused, handlers: h }: PaletteInput): PaletteItem[] {
  const items: PaletteItem[] = picked.length ? pickedActions(picked, h) : selected ? selectedActions(selected, h) : [];
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
    ...GO_KEYS.map((g) => command(`go-${g.to}`, g.label, () => h.goTo(g.to), keyCaps(g.key).join(' then '))),
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

const SELECTED_BONUS = 500;

export function searchPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  return rank(
    items,
    query,
    (i) => i.fields,
    (i) => (i.forSelected ? SELECTED_BONUS : 0),
  );
}
