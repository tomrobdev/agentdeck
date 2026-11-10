// Which commit this dashboard is running. Fixed at build time; in dev it is re-read after each hot reload.
import { ref } from 'vue';

export const appCommit = ref<string | null>(__APP_COMMIT__);

if (import.meta.hot) {
  import.meta.hot.on('vite:afterUpdate', async () => {
    try {
      const res = await fetch('/__agentdeck/commit');
      appCommit.value = ((await res.json()) as { commit: string | null }).commit;
    } catch {}
  });
}
