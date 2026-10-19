import { createApp } from 'vue';
import App from './App.vue';
import './themes.css';
import './style.css';
import { initTheme } from './theme';

initTheme();
createApp(App).mount('#app');
