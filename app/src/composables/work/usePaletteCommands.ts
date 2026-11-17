import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { operationsApi } from '#api/operations.ts';
import { runsApi } from '#api/runs.ts';
import { PERSON_CALLS } from '#api/work.ts';
import type { TaskSummary } from '#api/types.ts';
import { type PersonEvent } from '#daemon/domain/work/index.ts';
import { type PaletteTask, paletteItems } from '#lib/work/palette.ts';
import { openingTab } from '#lib/work/task-view.ts';
import { mode, setMode } from '#platform/theme.ts';
import { taskUrl } from '#lib/shared/app-url.ts';
import type { Actions } from '#composables/shared/useActions.ts';
import { openPanel, showKeys, startMerge, useShell } from '#composables/shared/useShell.ts';
import { useFixTask } from '#composables/work/useFixTask.ts';
import type { Approvals } from '#composables/work/useApprovals.ts';
import { requestedBulk, requestedEdit, requestedView } from '#composables/work/queue/useView.ts';

export function useTaskActs(tasks: () => TaskSummary[], { run, defer }: Pick<Actions, 'run' | 'defer'>, { approve }: Approvals) {
  const router = useRouter();
  const actOn = (kind: PersonEvent, id: number) =>
    kind === 'reject'
      ? defer(`Rejected #${id}`, () => PERSON_CALLS.reject(id))
      : kind === 'approve'
        ? void approve([id])
        : run(() => PERSON_CALLS[kind](id));
  function openFromQueue(id: number) {
    const t = tasks().find((x) => x.id === id);
    void router.push({ name: 'task', params: { id, tab: t ? openingTab(t) : 'overview' } });
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
  const route = useRoute();
  const router = useRouter();
  const { goPage, goTo } = useShell();
  const { actOn, openFromQueue } = useTaskActs(input.tasks, actions, approvals);
  const fixTask = useFixTask();
  const fixHandler = () => ({
    terminal: fixTask.terminalName(),
    run: (id: number) => {
      const t = input.tasks().find((x) => x.id === id);
      if (t) void fixTask.fix(t);
    },
  });
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
        fix: fixTask.available.value ? fixHandler() : null,
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
          void router.push({ name: 'queue' });
        },
        toggleTheme: () => setMode(mode.value === 'dark' ? 'light' : 'dark'),
        goTo,
        showKeys,
        showStates: (states) => goPage({ name: 'queue', query: { states: states.join(',') } }),
        edit: (request) => {
          if (route.name !== 'queue' && route.name !== 'task') void router.push({ name: 'queue' });
          requestedEdit.value = request;
        },
        bulk: (action) => {
          if (route.name !== 'queue') void router.push({ name: 'queue' });
          requestedBulk.value = action;
        },
      },
    }),
  );
}
