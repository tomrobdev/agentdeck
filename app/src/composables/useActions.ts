// What every button that changes something does the same way: run it, refresh the page's data after
// it worked, and flash the error if it didn't. App creates this once; components `useActions()` it.
import { type InjectionKey, type Ref, computed, inject, provide, ref } from 'vue';
import { errorMessage } from '../../../daemon/src/domain/shared/index.ts';

export type RunOptions = {
  done?: string;
  /** Counts this run while it is going, so the caller's own buttons can disable themselves (see `useAction`). */
  pending?: Ref<number>;
};

export type Actions = {
  /** Runs `fn`, then refreshes. Flashes `done` on success, or the error on failure. True when it worked. */
  run: (fn: () => Promise<unknown>, opts?: RunOptions) => Promise<boolean>;
  /** For callers that handle their own errors (inline in a dialog) but still need the refresh. */
  refresh: () => Promise<unknown>;
  flash: Flash;
  /** Waits 5 seconds behind a toast with Undo, then runs `fn` and refreshes. Undo drops it; closing the window never sends it. */
  defer: (message: string, fn: () => Promise<unknown>, onUndo?: () => void) => void;
};

/** Shows a message; with `action`, a button on the toast (Undo). Later messages stack under it. */
export type Flash = (msg: string, action?: { label: string; run: () => void }) => void;

/** How long a rejected or cancelled task waits for Undo. */
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

/** A button group's own `run` and its `pending` flag: true only while this group's actions are running. */
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
