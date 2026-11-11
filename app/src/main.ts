import { createApp } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import App from '#src/App.vue';
import TrayView from '#components/layout/TrayView.vue';
import '#styles/themes.css';
import '#styles/style.css';
import { initTheme } from '#platform/theme.ts';
import { retryQuery } from '#api/http.ts';
import { router } from '#src/router.ts';

initTheme();
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: retryQuery, refetchOnWindowFocus: true } } });
void router.replace(router.options.history.location);
void router.isReady().then(() => {
  const root = router.currentRoute.value.name === 'tray' ? TrayView : App;
  createApp(root).use(router).use(VueQueryPlugin, { queryClient }).mount('#app');
});
