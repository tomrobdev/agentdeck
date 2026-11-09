// The dashboard's theme (a set of colours, styles/themes.css) and mode (system, light or dark).
// Applied as data-theme and data-mode on <html>, so switching is one attribute write and every CSS variable follows at once.
import { ref } from 'vue';
import { loadSetting, saveSetting } from '../lib/shared/storage';

export const THEMES = [
  { key: 'warm', label: 'Warm', hint: 'Neutral greys, terracotta accent' },
  { key: 'cool', label: 'Cool', hint: 'Blue-grey with an indigo accent, like Linear' },
  { key: 'github', label: 'GitHub', hint: 'Primer greys with the blue link accent' },
  { key: 'contrast', label: 'High contrast', hint: 'Black and white, strong edges (default)' },
] as const;
export type ThemeKey = (typeof THEMES)[number]['key'];

export const MODES = [
  { key: 'system', label: 'System' },
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
] as const;
export type ModeKey = (typeof MODES)[number]['key'];

const pick = <T extends { key: string }>(list: readonly T[], key: unknown, fallback: T['key']) =>
  (list.find((x) => x.key === key)?.key ?? fallback) as T['key'];

export const theme = ref<ThemeKey>(pick(THEMES, loadSetting<unknown>('theme', null), 'contrast'));
export const mode = ref<ModeKey>(pick(MODES, loadSetting<unknown>('mode', null), 'light'));

function apply() {
  document.documentElement.dataset.theme = theme.value;
  document.documentElement.dataset.mode = mode.value;
}

export function setTheme(key: ThemeKey) {
  theme.value = key;
  saveSetting('theme', key);
  apply();
}

export function setMode(key: ModeKey) {
  mode.value = key;
  saveSetting('mode', key);
  apply();
}

/** Apply the stored choice. Called once, before the app mounts, so there is no flash of the wrong theme. */
export function initTheme() {
  apply();
}
