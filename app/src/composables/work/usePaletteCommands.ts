import { computed } from 'vue';
import { operationsApi } from '../../api/operations';
import { runsApi } from '../../api/runs';
import { PERSON_CALLS } from '../../api/work';
import type { TaskSummary } from '../../api/types';
import { type PersonEvent } from '../../../../daemon/src/domain/work/index.ts';
import { type PaletteTask, paletteItems } from '../../lib/work/palette';
import { openingTab } from '../../lib/work/task-view';
import { mode, setMode } from '../../platform/theme';
import { go, openTask, route, taskUrl } from '../../router';
import type { Actions } from '../shared/useActions';
import { goPage, goTo, openPanel, showKeys, startMerge } from '../shared/useShell';
import type { Approvals } from './useApprovals';
import { requestedBulk, requestedEdit, requestedView } from './queue/useView';

export function useTaskActs(tasks: () => TaskSummary[], { run, defer }: Pick<Actions, 'run' | 'defer'>, { approve }: Approvals) {
  const actOn = (kind: PersonEvent, id: number) =>
    kind === 'reject'
      ? defer(`Rejected #${id}`, () => PERSON_CALLS.reject(id))
      : kind === 'approve'
        ? void approve([id])
        : run(() => PERSON_CALLS[kind](id));
  function openFromQueue(id: number) {
    const t = tasks().find((x) => x.id === id);
    openTask(id, t ? openingTab(t) : 'overview');
  }
  return { actOn, openFromQueue };
}

export interface PaletteInput {
  tasks: () => TaskSummary[];
  selected: () => PaletteTask | null;
  picked: () => TaskSummary[];
  paused: () => boolean;
  togglePause: () => void;
}

export function usePaletteCommands(input: PaletteInput, actions: Actions, approvals: Approvals) {
  const { run, flash } = actions;
  const { actOn, openFromQueue } = useTaskActs(input.tasks, actions, approvals);
  return computed(() =>
    paletteItems({
      tasks: input.tasks(),
      selected: input.selected(),
      picked: input.picked(),
      paused: input.paused(),
      handlers: {
        open: openFromQueue,
        act: actOn,
        merge: startMerge,
        verify: (id) => run(() => runsApi.verify(id), { done: `Verify run started on #${id}` }),
        copyLink: (id) => {
          navigator.clipboard.writeText(taskUrl(id)).then(
            () => flash(`Copied ${taskUrl(id)}`),
            () => flash('Could not copy the link'),
          );
        },
        newTask: () => openPanel('new'),
        togglePause: input.togglePause,
        restartDaemon: () =>
          run(async () => {
            const res = await operationsApi.restartDaemon();
            flash(res.waiting ? `Waiting for ${res.waiting} to finish, then the daemon restarts.` : 'Restarting the daemon…');
          }),
        view: (m) => {
          requestedView.value = m;
          go({ name: 'queue' });
        },
        toggleTheme: () => setMode(mode.value === 'dark' ? 'light' : 'dark'),
        go: goTo,
        showKeys,
        showStates: (states) => goPage({ name: 'queue', states }),
        edit: (request) => {
          if (route.current.name !== 'queue' && route.current.name !== 'task') go({ name: 'queue' });
          requestedEdit.value = request;
        },
        bulk: (action) => {
          if (route.current.name !== 'queue') go({ name: 'queue' });
          requestedBulk.value = action;
        },
      },
    }),
  );
}
