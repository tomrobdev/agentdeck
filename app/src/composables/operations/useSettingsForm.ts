import { computed, onMounted, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { operationsApi, serviceQuery, settingsQuery } from '#api/operations.ts';
import type { Settings } from '#api/types.ts';
import { type SettingsForm, toSettingsForm, toSettingsPatch } from '#lib/shared/forms.ts';
import { editorTemplate, saveEditorTemplate, saveTerminalTemplate, terminalTemplate } from '#lib/runs/terminal.ts';
import { launchAtLogin, setLaunchAtLogin } from '#platform/native.ts';
import { errorMessage } from '#daemon/domain/shared/index.ts';
import { useActions } from '#composables/shared/useActions.ts';

export function useSettingsForm(close: () => void) {
  const { run } = useActions();
  const form = ref<SettingsForm | null>(null);
  const appAtLogin = ref<boolean | null>(null);
  const error = ref('');
  const saving = ref(false);
  const tested = ref('');
  const terminalCmd = ref(terminalTemplate());
  const editorCmd = ref(editorTemplate());

  function load(s: Settings) {
    form.value = toSettingsForm(s);
  }

  const settingsQ = useQuery(settingsQuery());
  watch(
    () => settingsQ.data.value,
    (s) => s && !form.value && load(s),
    { immediate: true },
  );
  const serviceQ = useQuery(serviceQuery());
  const service = computed(() => serviceQ.data.value ?? null);
  const failure = computed(() => error.value || settingsQ.error.value?.message || serviceQ.error.value?.message || '');

  onMounted(async () => {
    try {
      appAtLogin.value = await launchAtLogin();
    } catch (e) {
      error.value = errorMessage(e);
    }
  });

  async function toggleAppAtLogin() {
    try {
      await setLaunchAtLogin(!appAtLogin.value);
      appAtLogin.value = await launchAtLogin();
    } catch (e) {
      error.value = errorMessage(e);
    }
  }

  async function save(closeAfter = true) {
    if (!form.value) return;
    saveTerminalTemplate(terminalCmd.value);
    saveEditorTemplate(editorCmd.value);
    const patch = toSettingsPatch(form.value);
    error.value = '';
    saving.value = true;
    const ok = await run(async () => load(await operationsApi.updateSettings(patch)));
    saving.value = false;
    if (ok && closeAfter) close();
    return ok;
  }

  async function test() {
    tested.value = '';
    try {
      if (!(await save(false))) return;
      await operationsApi.testNotify();
      tested.value = 'Sent';
    } catch (e) {
      tested.value = errorMessage(e);
    }
  }

  return { form, service, failure, saving, tested, terminalCmd, editorCmd, appAtLogin, toggleAppAtLogin, save, test };
}
