import { createApp } from 'vue';
import App from './App.vue';
import './styles/themes.css';
import './styles/style.css';
import { initTheme } from './platform/theme';

initTheme();
createApp(App).mount('#app');
