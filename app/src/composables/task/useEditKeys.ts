// The edit keys on the queue and a task page: `e` the prompt, `p` then a digit the priority, `M` the model, `l` a link.
// They edit every picked task when some are picked (through the bulk edits), else the selected or open one. A prompt is
// one task's: with several picked it says so. The dialog for `e`, `M` and `l` is components/task/EditKeyDialog.vue.
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { api } from '../../api/client';
import { tasksQuery } from '../../api/queries';
import type { TaskSummary } from '../../api/types';
import { type BulkEdit } from '../../lib/queue/bulk';
import { type EditRequest, PRIORITY_KEYS } from '../../lib/shared/hotkeys';
import { PRIORITY_LEVELS, levelPriority } from '../../lib/task/task-view';
import { useAction, useActions } from '../shared/useActions';
import { useBulkEdit } from '../queue/useBulkEdit';
import { type HotkeyBinding } from '../shared/useHotkeys';
import { usePicked } from '../queue/usePicked';
import { requestedEdit } from '../shared/useView';

export type KeyEdit = 'prompt' | 'model' | 'link';
type EditPriority = Extract<EditRequest, { kind: 'priority' }>['level'];

export function useEditKeys(scope: 'queue' | 'task', current: () => number | null) {
  const tasksQ = useQuery(tasksQuery());
  const { picked } = usePicked();
  const { run, pending } = useAction();
  const { flash } = useActions();
  const edit = useBulkEdit(run);
  const dialog = ref<KeyEdit | null>(null);

  /** The picked tasks, else the selected or open one. */
  const targets = computed<TaskSummary[]>(() => {
    const all = tasksQ.data.value ?? [];
    if (picked.value.length) return all.filter((t) => picked.value.includes(t.id));
    const one = all.find((t) => t.id === current());
    return one ? [one] : [];
  });
  const fromPicks = () => picked.value.length > 0;

  function open(kind: KeyEdit) {
    if (!targets.value.length) return;
    if (kind === 'prompt' && targets.value.length > 1) {
      flash('A prompt is edited on one task at a time. Press Esc to clear the picks, then select a task.');
      return;
    }
    dialog.value = kind;
  }
  function setPriority(level: EditPriority) {
    const l = PRIORITY_LEVELS.find((x) => x.key === level)!;
    return edit(targets.value, 'priority', levelPriority(l), l.label.toLowerCase(), undefined, fromPicks());
  }
  const setModel = (model: string) => edit(targets.value, 'model', model, model, undefined, fromPicks());
  const setLink = (kind: Extract<BulkEdit, 'builds_on' | 'after'>, on: number) => edit(targets.value, kind, null, '', on, fromPicks());
  const savePrompt = (id: number, prompt: string) => run(() => api.editTask(id, { prompt }));

  // The palette asks for an edit; apply it when it arrives (also when this mounts after the palette sent it, as on a page change).
  watch(
    [requestedEdit, targets],
    ([request]) => {
      if (!request || !targets.value.length) return;
      requestedEdit.value = null;
      if (request.kind === 'priority') void setPriority(request.level);
      else open(request.kind);
    },
    { immediate: true },
  );

  const keys: Record<string, HotkeyBinding> = {
    e: { label: 'Edit the prompt', scope, run: () => open('prompt') },
    M: { label: 'Set the model', scope, run: () => open('model') },
    l: { label: 'Link to another task', scope, run: () => open('link') },
  };
  for (const { key, level, label } of PRIORITY_KEYS) {
    keys[`p ${key}`] = { label: `Set the priority: ${label.toLowerCase()}`, scope, run: () => targets.value.length && setPriority(level) };
  }
  return { keys, dialog, targets, pending, setModel, setLink, savePrompt, close: () => (dialog.value = null) };
}

export type EditKeys = ReturnType<typeof useEditKeys>;
