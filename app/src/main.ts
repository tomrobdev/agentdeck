import { createApp } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import App from './App.vue';
import TrayView from './components/layout/TrayView.vue';
import './styles/themes.css';
import './styles/style.css';
import { initTheme } from './platform/theme';
import { retryQuery } from './api';
import { route } from './router';

initTheme();
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: retryQuery, refetchOnWindowFocus: true } } });
// The tray window loads the same page at #/tray and mounts its own root: no header, status bar or link handling.
const root = route.current.name === 'tray' ? TrayView : App;
createApp(root).use(VueQueryPlugin, { queryClient }).mount('#app');
