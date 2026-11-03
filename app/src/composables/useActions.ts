// What every button that changes something does the same way: run it, refresh the page's data after
// it worked, and flash the error if it didn't. App creates this once; components `useActions()` it.
import { type InjectionKey, type Ref, computed, inject, provide, ref } from 'vue';

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
  flash: (msg: string) => void;
};

const KEY: InjectionKey<Actions> = Symbol('actions');

export function createActions(refresh: () => Promise<unknown>, flash: (msg: string) => void): Actions {
  async function run(fn: () => Promise<unknown>, opts: RunOptions = {}) {
    const pending = opts.pending;
    if (pending) pending.value++;
    try {
      await fn();
      await refresh();
      if (opts.done) flash(opts.done);
      return true;
    } catch (e) {
      flash((e as Error).message);
      return false;
    } finally {
      if (pending) pending.value--;
    }
  }
  return { run, refresh, flash };
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

export function provideActions(refresh: () => Promise<unknown>, flash: (msg: string) => void): Actions {
  const actions = createActions(refresh, flash);
  provide(KEY, actions);
  return actions;
}

export function useActions(): Actions {
  const actions = inject(KEY);
  if (!actions) throw new Error('useActions() needs App to provideActions() first');
  return actions;
}
