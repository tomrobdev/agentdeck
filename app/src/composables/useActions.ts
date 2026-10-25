// What every button that changes something does the same way: run it, refresh the page's data after
// it worked, and flash the error if it didn't. App creates this once; components `useActions()` it.
import { type InjectionKey, type Ref, computed, inject, provide, ref } from 'vue';

export type Actions = {
  /** True while any action is running. */
  busy: Readonly<Ref<boolean>>;
  /** Runs `fn`, then refreshes. Flashes `done` on success, or the error on failure. True when it worked. */
  run: (fn: () => Promise<unknown>, opts?: { done?: string }) => Promise<boolean>;
  /** For callers that handle their own errors (inline in a dialog) but still need the refresh. */
  refresh: () => Promise<unknown>;
  flash: (msg: string) => void;
};

const KEY: InjectionKey<Actions> = Symbol('actions');

export function createActions(refresh: () => Promise<unknown>, flash: (msg: string) => void): Actions {
  const running = ref(0);
  async function run(fn: () => Promise<unknown>, opts: { done?: string } = {}) {
    running.value++;
    try {
      await fn();
      await refresh();
      if (opts.done) flash(opts.done);
      return true;
    } catch (e) {
      flash((e as Error).message);
      return false;
    } finally {
      running.value--;
    }
  }
  return { busy: computed(() => running.value > 0), run, refresh, flash };
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
