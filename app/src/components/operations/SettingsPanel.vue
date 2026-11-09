<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { api } from '../../api/client';
import { MODEL_LABELS, ago } from '../../api/format';
import { serviceQuery, settingsQuery } from '../../api/queries';
import type { NotificationRow, Settings } from '../../api/types';
import { errorMessage } from '../../../../daemon/src/domain/shared/index.ts';
import { type SettingsForm, modelChoices, toSettingsForm, toSettingsPatch } from '../../lib/shared/forms';
import { MODELS } from '../../lib/work/task-view';
import {
  CMUX_TEMPLATE,
  EDITOR_PRESETS,
  editorTemplate,
  saveEditorTemplate,
  saveTerminalTemplate,
  terminalTemplate,
} from '../../lib/runs/terminal';
import { isNative, launchAtLogin, setLaunchAtLogin } from '../../platform/native';
import { MODES, THEMES, mode, setMode, setTheme, theme } from '../../platform/theme';
import { useActions } from '../../composables/shared/useActions';
import { approveDialogSetting, setApproveDialogSetting } from '../../composables/work/useApprovals';
import { APPROVE_DIALOG_SETTINGS, asApproveDialogSetting } from '../../lib/work/approve-dialog';
import BudgetSettings from './settings/BudgetSettings.vue';
import NotificationSettings from './settings/NotificationSettings.vue';
import Chip from '../ui/Chip.vue';
import Modal from '../ui/Modal.vue';
import NumberInput from '../ui/form/NumberInput.vue';
import RadioGroup from '../ui/form/RadioGroup.vue';
import Switch from '../ui/form/Switch.vue';
import SegmentedControl from '../ui/form/SegmentedControl.vue';

defineProps<{ notifications: NotificationRow[] }>();
const emit = defineEmits<{ close: [] }>();
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

async function toggleAppAtLogin() {
  try {
    await setLaunchAtLogin(!appAtLogin.value);
    appAtLogin.value = await launchAtLogin();
  } catch (e) {
    error.value = errorMessage(e);
  }
}

// The form is a copy to edit: it takes the first answer, and a save replaces it. Later refetches don't touch it.
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

/** An alert's chip tone: a budget or pause alert looks like a blocked task. */
function alertTone(kind: NotificationRow['kind']) {
  return kind === 'hold' || kind === 'paused' ? 'blocked' : kind;
}

async function save(close = true) {
  if (!form.value) return;
  saveTerminalTemplate(terminalCmd.value);
  saveEditorTemplate(editorCmd.value);
  const patch = toSettingsPatch(form.value);
  error.value = '';
  saving.value = true;
  const ok = await run(async () => load(await api.updateSettings(patch)));
  saving.value = false;
  if (ok && close) emit('close');
  return ok;
}

async function test() {
  tested.value = '';
  try {
    if (!(await save(false))) return;
    await api.testNotify();
    tested.value = 'Sent';
  } catch (e) {
    tested.value = errorMessage(e);
  }
}
</script>

<template>
  <Modal title="Settings" @close="$emit('close')">
    <p v-if="!form && !failure" class="text-muted">Loading…</p>
    <form v-if="form" class="flex flex-col gap-[18px]" @submit.prevent="save()">
      <section class="flex flex-col gap-2.5">
        <h4 class="m-0">Appearance</h4>
        <p class="text-muted m-0 text-sm">Applies as you pick, and is remembered on this computer.</p>
        <RadioGroup
          cards
          label="Theme"
          :options="THEMES.map((t) => ({ key: t.key, label: t.label, hint: t.hint }))"
          :model-value="theme"
          @update:model-value="setTheme"
        />
        <SegmentedControl
          class="self-start"
          label="Mode"
          :options="MODES.map((m) => ({ value: m.key, label: m.label }))"
          :model-value="mode"
          @update:model-value="setMode"
        />
      </section>

      <section class="flex flex-col gap-2.5">
        <h4 class="m-0">Approving</h4>
        <p class="text-muted m-0 text-sm">
          Open a dialog before approving, with how far main has moved, notes and overlaps, and a place to edit each prompt. Applies as you
          pick, and is remembered on this computer.
        </p>
        <SegmentedControl
          class="self-start"
          label="Approve dialog"
          :options="APPROVE_DIALOG_SETTINGS.map((s) => ({ value: s.key, label: s.label }))"
          :model-value="approveDialogSetting"
          @update:model-value="(v) => setApproveDialogSetting(asApproveDialogSetting(v))"
        />
      </section>

      <BudgetSettings :form="form" />

      <section class="flex flex-col gap-2.5">
        <h4 class="m-0">Models</h4>
        <div class="grid grid-cols-2 gap-x-4 gap-y-3">
          <label class="field">
            <span>Default model <span class="text-muted">(a new task's, unless it or its repo names one)</span></span>
            <select v-model="form.default_model">
              <option v-for="m in modelChoices(form.default_model)" :key="m" :value="m">{{ MODEL_LABELS[m] ?? m }}</option>
            </select>
          </label>
          <label class="field">
            <span>Support model <span class="text-muted">(resolve and unblock runs)</span></span>
            <select v-model="form.support_model">
              <option v-for="m in modelChoices(form.support_model)" :key="m" :value="m">{{ MODEL_LABELS[m] ?? m }}</option>
            </select>
          </label>
        </div>
      </section>

      <section class="flex flex-col gap-2.5">
        <h4 class="m-0">Planner</h4>
        <p class="text-muted m-0 text-sm">
          When a repo with goals has nothing queued, the planner reads its goals and code and proposes the next tasks. Write goals under
          Repos.
        </p>
        <Switch v-model="form.planner_enabled">Propose tasks automatically when a queue runs dry</Switch>
        <div class="grid grid-cols-3 gap-x-4 gap-y-3">
          <label class="field">
            <span>At most every</span>
            <span class="flex items-center gap-1.5 [&_input]:w-20"
              ><NumberInput v-model="form.planner_interval_hours" :step="0.25" />hours</span
            >
          </label>
          <label class="field">
            <span>Tasks per proposal run</span>
            <NumberInput v-model="form.planner_max_tasks" />
          </label>
          <label class="field">
            <span>Planner model</span>
            <select v-model="form.planner_model">
              <option v-for="m in MODELS" :key="m" :value="m">{{ MODEL_LABELS[m] ?? m }}</option>
            </select>
          </label>
        </div>
      </section>

      <section class="flex flex-col gap-2.5">
        <h4 class="m-0">Always on</h4>
        <div class="flex flex-col items-start gap-1.5">
          <Chip :tone="service?.state === 'running' ? 'done' : 'blocked'" variant="tint" dot>
            {{ service?.installed ? `Daemon runs at login · ${service.state ?? 'not loaded'}` : 'Daemon not installed' }}
          </Chip>
          <small v-if="!service?.installed" class="text-muted text-xs"
            >Run <code>agentdeck install</code> once and it starts at login and restarts if it dies.</small
          >
        </div>
        <Switch v-model="form.reload_on_change">Restart the daemon when its source changes (for developing AgentDeck)</Switch>
        <small class="text-muted text-xs"
          >Once something in daemon/src changed and no task or planner run is active, it exits and launchd starts the new code.</small
        >
        <Switch v-if="isNative" :model-value="!!appAtLogin" @update:model-value="toggleAppAtLogin">
          Open this dashboard at login (in the menu bar)
        </Switch>
      </section>

      <section v-if="isNative" class="flex flex-col gap-2.5">
        <h4 class="m-0">Terminal</h4>
        <label class="field">
          <span>Command that opens a terminal</span>
          <input v-model="terminalCmd" class="font-mono" spellcheck="false" />
          <small class="text-muted text-xs">
            Split into arguments on spaces ("quotes" keep spaces together) and run without a shell. <code>{title}</code>,
            <code>{cwd}</code> and <code>{command}</code> are filled in; without a command, <code>{command}</code> and the flag before it
            are left out. cmux is found even though it is not on the app's PATH. Remembered on this computer.
          </small>
        </label>
        <button type="button" class="self-start" :disabled="terminalCmd === CMUX_TEMPLATE" @click="terminalCmd = CMUX_TEMPLATE">
          Use cmux
        </button>
      </section>

      <section v-if="isNative" class="flex flex-col gap-2.5">
        <h4 class="m-0">Editor</h4>
        <label class="field">
          <span>Command that opens a task's worktree in your editor</span>
          <input v-model="editorCmd" class="font-mono" spellcheck="false" placeholder="not set" />
          <small class="text-muted text-xs">
            Run like the terminal command, with <code>{cwd}</code> filled in. Leave it empty and the task's "open in editor" button is
            hidden. Remembered on this computer.
          </small>
        </label>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="p in EDITOR_PRESETS"
            :key="p.name"
            type="button"
            :disabled="editorCmd === p.template"
            @click="editorCmd = p.template"
          >
            {{ p.name }}
          </button>
        </div>
      </section>

      <NotificationSettings :form="form" />

      <section v-if="notifications.length" class="flex flex-col gap-2.5">
        <h4 class="m-0">Recent alerts</h4>
        <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
          <li v-for="n in notifications.slice(0, 5)" :key="n.id" class="flex items-center gap-2">
            <Chip :status="alertTone(n.kind)" variant="tint">{{ n.kind }}</Chip>
            <span class="flex-1 truncate">{{ n.title }}</span>
            <span class="text-muted">{{ ago(n.created_at) }}</span>
          </li>
        </ul>
      </section>

      <p v-if="failure" class="form-error">{{ failure }}</p>
      <div class="flex items-center gap-2">
        <button type="button" @click="test" :disabled="saving">Save &amp; send test</button>
        <span class="text-muted">{{ tested }}</span>
        <span class="spacer" />
        <button type="button" @click="$emit('close')">Cancel</button>
        <button class="primary" type="submit" :disabled="saving">Save</button>
      </div>
    </form>
    <p v-else-if="failure" class="form-error">{{ failure }}</p>
  </Modal>
</template>
