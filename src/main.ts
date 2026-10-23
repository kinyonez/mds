import { mount } from 'svelte';
import { registerSW } from 'virtual:pwa-register';
import App from './App.svelte';
import { app } from './lib/app.svelte';
import { initTheme } from './lib/platform/theme';
import { trackViewport } from './lib/platform/viewport';
import './styles.css';

initTheme();
trackViewport();

// 新バージョンを検知したら「更新があります」バナーを出してリロードを促す
const update = registerSW({
  onNeedRefresh() {
    app.updateAvailable = true;
  },
});
app.applyUpdate = () => void update(true);

mount(App, { target: document.getElementById('app')! });
void app.init();
