import { createApp } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import App from './App.vue';
import './styles/themes.css';
import './styles/style.css';
import { initTheme } from './platform/theme';
import { retryQuery } from './api';

initTheme();
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: retryQuery, refetchOnWindowFocus: true } } });
createApp(App).use(VueQueryPlugin, { queryClient }).mount('#app');
