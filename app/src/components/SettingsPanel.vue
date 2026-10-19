<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { type NotificationRow, type NotifyKind, type ServiceStatus, type Settings, ago, api } from '../api';
import { isNative, launchAtLogin, setLaunchAtLogin } from '../native';
import { MODES, THEMES, mode, setMode, setTheme, theme } from '../theme';
import Modal from './Modal.vue';

defineProps<{ notifications: NotificationRow[] }>();
const emit = defineEmits<{ close: []; saved: [] }>();

const EVENTS: { key: NotifyKind; label: string }[] = [
  { key: 'blocked', label: 'Task blocked' },
  { key: 'failed', label: 'Task failed' },
  { key: 'done', label: 'Task done' },
  { key: 'hold', label: 'Work held by budget' },
  { key: 'proposed', label: 'Planner proposals' },
];

// Edited as whole percentages, stored as 0..1.
const form = ref<{
  max_concurrent: number;
  five_hour_max: number;
  five_hour_soft: number;
  weekly_max: number;
  pace_slack: number;
  desktop: boolean;
  events: NotifyKind[];
  ntfy_topic: string;
  planner_enabled: boolean;
  planner_interval_hours: number;
  planner_max_tasks: number;
  planner_model: string;
  reload_on_change: boolean;
} | null>(null);
const service = ref<ServiceStatus | null>(null);
const appAtLogin = ref<boolean | null>(null);
const error = ref('');
const saving = ref(false);
const tested = ref('');

const toPct = (x: number) => Math.round(x * 100);

function load(s: Settings) {
  form.value = {
    max_concurrent: s.max_concurrent,
    five_hour_max: toPct(s.budget.five_hour_max),
    five_hour_soft: toPct(s.budget.five_hour_soft),
    weekly_max: toPct(s.budget.weekly_max),
    pace_slack: toPct(s.budget.pace_slack),
    desktop: s.notify.desktop,
    events: [...s.notify.events],
    ntfy_topic: s.notify.ntfy_topic,
    planner_enabled: s.planner.enabled,
    planner_interval_hours: s.planner.interval_hours,
    planner_max_tasks: s.planner.max_tasks,
    planner_model: s.planner.model,
    reload_on_change: s.reload_on_change,
  };
}

async function toggleAppAtLogin() {
  try {
    await setLaunchAtLogin(!appAtLogin.value);
    appAtLogin.value = await launchAtLogin();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(async () => {
  try {
    load(await api.settings());
    service.value = await api.service();
    appAtLogin.value = await launchAtLogin();
  } catch (e) {
    error.value = (e as Error).message;
  }
});

/** Plain-language summary of the weekly plan. */
const perDay = computed(() => (form.value ? (form.value.weekly_max / 7).toFixed(1) : ''));

async function save(close = true) {
  if (!form.value) return;
  const f = form.value;
  error.value = '';
  saving.value = true;
  try {
    load(
      await api.updateSettings({
        max_concurrent: f.max_concurrent,
        reload_on_change: f.reload_on_change,
        budget: {
          five_hour_max: f.five_hour_max / 100,
          five_hour_soft: f.five_hour_soft / 100,
          weekly_max: f.weekly_max / 100,
          pace_slack: f.pace_slack / 100,
        },
        notify: { desktop: f.desktop, events: f.events, ntfy_topic: f.ntfy_topic },
        planner: {
          enabled: f.planner_enabled,
          interval_hours: f.planner_interval_hours,
          max_tasks: f.planner_max_tasks,
          model: f.planner_model,
        },
      }),
    );
    emit('saved');
    if (close) emit('close');
    return true;
  } catch (e) {
    error.value = (e as Error).message;
    return false;
  } finally {
    saving.value = false;
  }
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
    <p v-if="!form && !error" class="muted">Loading…</p>
    <form v-if="form" @submit.prevent="save()">
      <section>
        <h4>Appearance</h4>
        <p class="muted hint">
          Applies as you pick, and is remembered on this computer. The status bar has the same choice for quick comparing.
        </p>
        <div class="themes" role="radiogroup" aria-label="Theme">
          <label v-for="t in THEMES" :key="t.key" class="check theme" :class="{ on: theme === t.key }">
            <input type="radio" name="theme" :value="t.key" :checked="theme === t.key" @change="setTheme(t.key)" />
            <span
              ><b>{{ t.label }}</b
              ><small class="muted"> {{ t.hint }}</small></span
            >
          </label>
        </div>
        <div class="seg modes" role="group" aria-label="Mode">
          <button
            v-for="m in MODES"
            :key="m.key"
            type="button"
            :class="{ on: mode === m.key }"
            :aria-pressed="mode === m.key"
            @click="setMode(m.key)"
          >
            {{ m.label }}
          </button>
        </div>
      </section>

      <section>
        <h4>Usage budget</h4>
        <p class="muted hint">
          AgentDeck reads your 5-hour and 7-day usage from Claude. It never interrupts a running task; these limits only decide when new
          tasks may start, so the rest stays free for your own Claude use.
        </p>
        <div class="grid">
          <label>
            <span>5h cap</span>
            <span class="pct"><input type="number" min="1" max="100" v-model.number="form.five_hour_max" />%</span>
            <small class="muted">Hold new tasks above this.</small>
          </label>
          <label>
            <span>5h soft limit</span>
            <span class="pct"><input type="number" min="1" max="100" v-model.number="form.five_hour_soft" />%</span>
            <small class="muted">One task at a time above this.</small>
          </label>
          <label>
            <span>Weekly cap</span>
            <span class="pct"><input type="number" min="1" max="100" v-model.number="form.weekly_max" />%</span>
            <small class="muted">Spread evenly: about {{ perDay }}% a day.</small>
          </label>
          <label>
            <span>Pace slack</span>
            <span class="pct"><input type="number" min="0" max="100" v-model.number="form.pace_slack" />%</span>
            <small class="muted">How far ahead of even pace it may run.</small>
          </label>
          <label>
            <span>Max concurrent tasks</span>
            <input type="number" min="1" max="8" v-model.number="form.max_concurrent" />
          </label>
        </div>
      </section>

      <section>
        <h4>Planner</h4>
        <p class="muted hint">
          When a repo with goals has nothing queued, the planner reads its goals and code and proposes the next tasks. Write goals under
          Repos.
        </p>
        <label class="check"><input type="checkbox" v-model="form.planner_enabled" /> Plan automatically when a queue runs dry</label>
        <div class="grid three">
          <label>
            <span>At most every</span>
            <span class="pct"><input type="number" min="0.25" step="0.25" v-model.number="form.planner_interval_hours" />hours</span>
          </label>
          <label>
            <span>Tasks per plan</span>
            <input type="number" min="1" max="10" v-model.number="form.planner_max_tasks" />
          </label>
          <label>
            <span>Planner model</span>
            <select v-model="form.planner_model">
              <option value="haiku">Haiku</option>
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
            </select>
          </label>
        </div>
      </section>

      <section>
        <h4>Always on</h4>
        <div class="always">
          <span class="pill" :class="service?.state === 'running' ? 's-done' : 's-blocked'">
            <span class="dot" />{{
              service?.installed ? `Daemon runs at login · ${service.state ?? 'not loaded'}` : 'Daemon not installed'
            }}
          </span>
          <small v-if="!service?.installed" class="muted"
            >Run <code>agentdeck install</code> once and it starts at login and restarts if it dies.</small
          >
        </div>
        <label class="check">
          <input type="checkbox" v-model="form.reload_on_change" /> Restart the daemon when its source changes (for developing AgentDeck)
        </label>
        <small class="muted"
          >Once something in daemon/src changed and no task or planner run is active, it exits and launchd starts the new code.</small
        >
        <label v-if="isNative" class="check">
          <input type="checkbox" :checked="!!appAtLogin" @change="toggleAppAtLogin" /> Open this dashboard at login (in the menu bar)
        </label>
      </section>

      <section>
        <h4>Notifications</h4>
        <label class="check"><input type="checkbox" v-model="form.desktop" /> macOS notifications</label>
        <div class="events">
          <label v-for="e in EVENTS" :key="e.key" class="check">
            <input type="checkbox" :value="e.key" v-model="form.events" /> {{ e.label }}
          </label>
        </div>
        <label>
          <span>ntfy topic for phone alerts <span class="muted">(optional)</span></span>
          <input v-model="form.ntfy_topic" placeholder="e.g. agentdeck-7f3k2" />
          <small class="muted">
            Install the ntfy app and subscribe to the same topic. Task titles are sent to ntfy.sh, and anyone who knows the topic name can
            read them, so pick something hard to guess.
          </small>
        </label>
      </section>

      <section v-if="notifications.length">
        <h4>Recent alerts</h4>
        <ul class="recent">
          <li v-for="n in notifications.slice(0, 5)" :key="n.id">
            <span class="pill" :class="`s-${n.kind === 'hold' ? 'blocked' : n.kind}`">{{ n.kind }}</span>
            <span class="title">{{ n.title }}</span>
            <span class="muted">{{ ago(n.created_at) }}</span>
          </li>
        </ul>
      </section>

      <p v-if="error" class="error">{{ error }}</p>
      <div class="actions">
        <button type="button" @click="test" :disabled="saving">Save &amp; send test</button>
        <span class="muted">{{ tested }}</span>
        <span class="spacer" />
        <button type="button" @click="$emit('close')">Cancel</button>
        <button class="primary" type="submit" :disabled="saving">Save</button>
      </div>
    </form>
    <p v-else-if="error" class="error">{{ error }}</p>
  </Modal>
</template>

<style scoped>
form {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
h4 {
  margin: 0;
}
.hint {
  margin: 0;
  font-size: 12px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 16px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pct {
  display: flex;
  align-items: center;
  gap: 6px;
}
.pct input {
  width: 80px;
}
.grid.three {
  grid-template-columns: 1fr 1fr 1fr;
}
.always {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
small {
  font-size: 11px;
}
.check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.check input {
  width: auto;
}
.themes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.theme {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}
.theme.on {
  border-color: var(--accent);
}
.modes {
  align-self: flex-start;
}
.events {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}
.recent {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.recent li {
  display: flex;
  gap: 8px;
  align-items: center;
}
.recent .title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.spacer {
  flex: 1;
}
.error {
  color: var(--failed);
  margin: 0;
}
</style>
