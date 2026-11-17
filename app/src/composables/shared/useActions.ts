import { type InjectionKey, type Ref, computed, inject, provide, ref } from 'vue';
import { errorMessage } from '#daemon/domain/shared/index.ts';

export type RunOptions = {
  done?: string;
  pending?: Ref<number>;
};

export type Actions = {
  run: (fn: () => Promise<unknown>, opts?: RunOptions) => Promise<boolean>;
  refresh: () => Promise<unknown>;
  flash: Flash;
  defer: (message: string, fn: () => Promise<unknown>, onUndo?: () => void) => void;
};

export type Flash = (msg: string, action?: { label: string; run: () => void }) => void;

export const UNDO_MS = 5000;

const KEY: InjectionKey<Actions> = Symbol('actions');

export function createActions(refresh: () => Promise<unknown>, flash: Flash): Actions {
  async function run(fn: () => Promise<unknown>, opts: RunOptions = {}) {
    const pending = opts.pending;
    if (pending) pending.value++;
    try {
      await fn();
      await refresh();
      if (opts.done) flash(opts.done);
      return true;
    } catch (e) {
      flash(errorMessage(e));
      return false;
    } finally {
      if (pending) pending.value--;
    }
  }
  function defer(message: string, fn: () => Promise<unknown>, onUndo?: () => void) {
    let undone = false;
    const timer = setTimeout(() => {
      if (!undone) void run(fn);
    }, UNDO_MS);
    flash(message, {
      label: 'Undo',
      run: () => {
        undone = true;
        clearTimeout(timer);
        onUndo?.();
      },
    });
  }
  return { run, refresh, flash, defer };
}

export function trackPending(actions: Actions) {
  const count = ref(0);
  return {
    pending: computed(() => count.value > 0),
    run: (fn: () => Promise<unknown>, opts: Omit<RunOptions, 'pending'> = {}) => actions.run(fn, { ...opts, pending: count }),
  };
}

export function useAction() {
  return trackPending(useActions());
}

export function provideActions(refresh: () => Promise<unknown>, flash: Flash): Actions {
  const actions = createActions(refresh, flash);
  provide(KEY, actions);
  return actions;
}

export function useActions(): Actions {
  const actions = inject(KEY);
  if (!actions) throw new Error('useActions() needs App to provideActions() first');
  return actions;
}
