<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { type NotificationRow, type NotifyKind, type Settings, ago, api, serviceQuery, settingsQuery } from '../../api';
import { type SettingsForm, toSettingsForm, toSettingsPatch } from '../../lib/forms';
import { CMUX_TEMPLATE, saveTerminalTemplate, terminalTemplate } from '../../lib/terminal';
import { isNative, launchAtLogin, setLaunchAtLogin } from '../../platform/native';
import { MODES, THEMES, mode, setMode, setTheme, theme } from '../../platform/theme';
import { useActions } from '../../composables/useActions';
import Chip from '../ui/Chip.vue';
import Modal from '../ui/Modal.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';

defineProps<{ notifications: NotificationRow[] }>();
const emit = defineEmits<{ close: [] }>();
const { run } = useActions();

const EVENTS: { key: NotifyKind; label: string }[] = [
  { key: 'blocked', label: 'Task blocked' },
  { key: 'failed', label: 'Task failed' },
  { key: 'done', label: 'Task done' },
  { key: 'hold', label: 'Work held by budget' },
  { key: 'paused', label: 'Repo paused' },
  { key: 'proposed', label: 'Planner proposals' },
  { key: 'merged', label: 'PR auto-merged' },
  { key: 'checks_failed', label: 'PR checks failed' },
];

const form = ref<SettingsForm | null>(null);
const appAtLogin = ref<boolean | null>(null);
const error = ref('');
const saving = ref(false);
const tested = ref('');
const terminalCmd = ref(terminalTemplate());

function load(s: Settings) {
  form.value = toSettingsForm(s);
}

async function toggleAppAtLogin() {
  try {
    await setLaunchAtLogin(!appAtLogin.value);
    appAtLogin.value = await launchAtLogin();
  } catch (e) {
    error.value = (e as Error).message;
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
    error.value = (e as Error).message;
  }
});

/** Plain-language summary of the weekly plan. */
const perDay = computed(() => (form.value ? (form.value.weekly_max / 7).toFixed(1) : ''));

async function save(close = true) {
  if (!form.value) return;
  saveTerminalTemplate(terminalCmd.value);
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
    tested.value = (e as Error).message;
  }
}
</script>

<template>
  <Modal title="Settings" @close="$emit('close')">
    <p v-if="!form && !failure" class="muted">Loading…</p>
    <form v-if="form" class="flex flex-col gap-[18px]" @submit.prevent="save()">
      <section class="flex flex-col gap-2.5">
        <h4 class="m-0">Appearance</h4>
        <p class="muted m-0 text-sm">Applies as you pick, and is remembered on this computer.</p>
        <div class="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Theme">
          <label
            v-for="t in THEMES"
            :key="t.key"
            class="flex cursor-pointer items-center gap-2 rounded-sm border px-2 py-1.5"
            :class="theme === t.key ? 'border-accent' : 'border-border'"
          >
            <input type="radio" name="theme" :value="t.key" :checked="theme === t.key" @change="setTheme(t.key)" />
            <span
              ><b>{{ t.label }}</b
              ><small class="muted text-xs"> {{ t.hint }}</small></span
            >
          </label>
        </div>
        <SegmentedControl
          class="self-start"
          label="Mode"
          :options="MODES.map((m) => ({ value: m.key, label: m.label }))"
          :model-value="mode"
          @update:model-value="setMode"
        />
      </section>

      <section class="flex flex-col gap-2.5">
        <h4 class="m-0">Usage budget</h4>
        <p class="muted m-0 text-sm">
          AgentDeck reads your 5-hour and 7-day usage from Claude. It never interrupts a running task; these limits only decide when new
          tasks may start, so the rest stays free for your own Claude use.
        </p>
        <div class="grid grid-cols-2 gap-x-4 gap-y-3">
          <label class="field">
            <span>5h cap</span>
            <span class="flex items-center gap-1.5 [&_input]:w-20"
              ><input type="number" min="1" max="100" v-model.number="form.five_hour_max" />%</span
            >
            <small class="muted text-xs">Hold new tasks above this.</small>
          </label>
          <label class="field">
            <span>5h soft limit</span>
            <span class="flex items-center gap-1.5 [&_input]:w-20"
              ><input type="number" min="1" max="100" v-model.number="form.five_hour_soft" />%</span
            >
            <small class="muted text-xs">One task at a time above this.</small>
          </label>
          <label class="field">
            <span>Weekly cap</span>
            <span class="flex items-center gap-1.5 [&_input]:w-20"
              ><input type="number" min="1" max="100" v-model.number="form.weekly_max" />%</span
            >
            <small class="muted text-xs">Spread evenly: about {{ perDay }}% a day.</small>
          </label>
          <label class="field">
            <span>Pace slack</span>
            <span class="flex items-center gap-1.5 [&_input]:w-20"
              ><input type="number" min="0" max="100" v-model.number="form.pace_slack" />%</span
            >
            <small class="muted text-xs">How far ahead of even pace it may run.</small>
          </label>
          <label class="field">
            <span>Max concurrent tasks</span>
            <input type="number" min="1" max="8" v-model.number="form.max_concurrent" />
          </label>
        </div>
      </section>

      <section class="flex flex-col gap-2.5">
        <h4 class="m-0">Planner</h4>
        <p class="muted m-0 text-sm">
          When a repo with goals has nothing queued, the planner reads its goals and code and proposes the next tasks. Write goals under
          Repos.
        </p>
        <label class="flex items-center gap-2"
          ><input type="checkbox" v-model="form.planner_enabled" /> Plan automatically when a queue runs dry</label
        >
        <div class="grid grid-cols-3 gap-x-4 gap-y-3">
          <label class="field">
            <span>At most every</span>
            <span class="flex items-center gap-1.5 [&_input]:w-20"
              ><input type="number" min="0.25" step="0.25" v-model.number="form.planner_interval_hours" />hours</span
            >
          </label>
          <label class="field">
            <span>Tasks per plan</span>
            <input type="number" min="1" max="10" v-model.number="form.planner_max_tasks" />
          </label>
          <label class="field">
            <span>Planner model</span>
            <select v-model="form.planner_model">
              <option value="haiku">Haiku</option>
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
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
          <small v-if="!service?.installed" class="muted text-xs"
            >Run <code>agentdeck install</code> once and it starts at login and restarts if it dies.</small
          >
        </div>
        <label class="flex items-center gap-2">
          <input type="checkbox" v-model="form.reload_on_change" /> Restart the daemon when its source changes (for developing AgentDeck)
        </label>
        <small class="muted text-xs"
          >Once something in daemon/src changed and no task or planner run is active, it exits and launchd starts the new code.</small
        >
        <label v-if="isNative" class="flex items-center gap-2">
          <input type="checkbox" :checked="!!appAtLogin" @change="toggleAppAtLogin" /> Open this dashboard at login (in the menu bar)
        </label>
      </section>

      <section v-if="isNative" class="flex flex-col gap-2.5">
        <h4 class="m-0">Terminal</h4>
        <label class="field">
          <span>Command that opens a terminal</span>
          <input v-model="terminalCmd" class="font-mono" spellcheck="false" />
          <small class="muted text-xs">
            Split into arguments on spaces ("quotes" keep spaces together) and run without a shell. <code>{title}</code>,
            <code>{cwd}</code> and <code>{command}</code> are filled in; without a command, <code>{command}</code> and the flag before it
            are left out. cmux is found even though it is not on the app's PATH. Remembered on this computer.
          </small>
        </label>
        <button type="button" class="self-start" :disabled="terminalCmd === CMUX_TEMPLATE" @click="terminalCmd = CMUX_TEMPLATE">
          Use cmux
        </button>
      </section>

      <section class="flex flex-col gap-2.5">
        <h4 class="m-0">Notifications</h4>
        <label class="flex items-center gap-2"><input type="checkbox" v-model="form.desktop" /> macOS notifications</label>
        <div class="flex flex-wrap gap-x-4 gap-y-1.5">
          <label v-for="e in EVENTS" :key="e.key" class="flex items-center gap-2">
            <input type="checkbox" :value="e.key" v-model="form.events" /> {{ e.label }}
          </label>
        </div>
        <label class="field">
          <span>ntfy topic for phone alerts <span class="muted">(optional)</span></span>
          <input v-model="form.ntfy_topic" placeholder="e.g. agentdeck-7f3k2" />
          <small class="muted text-xs">
            Install the ntfy app and subscribe to the same topic. Task titles are sent to ntfy.sh, and anyone who knows the topic name can
            read them, so pick something hard to guess.
          </small>
        </label>
      </section>

      <section v-if="notifications.length" class="flex flex-col gap-2.5">
        <h4 class="m-0">Recent alerts</h4>
        <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
          <li v-for="n in notifications.slice(0, 5)" :key="n.id" class="flex items-center gap-2">
            <Chip :status="n.kind === 'hold' || n.kind === 'paused' ? 'blocked' : n.kind" variant="tint">{{ n.kind }}</Chip>
            <span class="flex-1 truncate">{{ n.title }}</span>
            <span class="muted">{{ ago(n.created_at) }}</span>
          </li>
        </ul>
      </section>

      <p v-if="failure" class="form-error">{{ failure }}</p>
      <div class="flex items-center gap-2">
        <button type="button" @click="test" :disabled="saving">Save &amp; send test</button>
        <span class="muted">{{ tested }}</span>
        <span class="spacer" />
        <button type="button" @click="$emit('close')">Cancel</button>
        <button class="primary" type="submit" :disabled="saving">Save</button>
      </div>
    </form>
    <p v-else-if="failure" class="form-error">{{ failure }}</p>
  </Modal>
</template>
