<script setup lang="ts">
import { ref } from 'vue';
import { useSettingsForm } from '#composables/operations/useSettingsForm.ts';
import { isNative } from '#platform/native.ts';
import Modal from '#components/ui/Modal.vue';
import AppearanceSettings from '#components/operations/settings/AppearanceSettings.vue';
import BudgetSettings from '#components/operations/settings/BudgetSettings.vue';
import CommandSettings from '#components/operations/settings/CommandSettings.vue';
import DaemonSettings from '#components/operations/settings/DaemonSettings.vue';
import ModelSettings from '#components/operations/settings/ModelSettings.vue';
import NotificationSettings from '#components/operations/settings/NotificationSettings.vue';
import SettingsNav from '#components/operations/settings/SettingsNav.vue';

const emit = defineEmits<{ close: [] }>();
const { form, service, failure, saving, tested, terminalCmd, editorCmd, appAtLogin, toggleAppAtLogin, save, test } = useSettingsForm(() =>
  emit('close'),
);

const scroller = ref<HTMLElement | null>(null);
const sections = [
  { id: 'settings-appearance', label: 'Appearance' },
  { id: 'settings-budget', label: 'Usage budget' },
  { id: 'settings-models', label: 'Models' },
  { id: 'settings-planner', label: 'Planner' },
  { id: 'settings-daemon', label: 'Daemon' },
  { id: 'settings-notifications', label: 'Notifications' },
  ...(isNative ? [{ id: 'settings-commands', label: 'Terminal and editor' }] : []),
];
</script>

<template>
  <Modal title="Settings" size="lg" :scroll="false" @close="$emit('close')">
    <div class="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[11rem_minmax(0,1fr)]">
      <aside class="hidden border-r border-border p-3 sm:block">
        <SettingsNav v-if="scroller && form" :sections="sections" :scroller="scroller" />
      </aside>
      <div ref="scroller" class="pane-body">
        <p v-if="!form && !failure" class="text-muted">Loading…</p>
        <form v-if="form" id="settings-form" class="flex flex-col gap-8" @submit.prevent="save()">
          <AppearanceSettings />
          <BudgetSettings :form="form" />
          <ModelSettings :form="form" />
          <DaemonSettings :form="form" :service="service" :app-at-login="appAtLogin" @toggle-app-at-login="toggleAppAtLogin" />
          <NotificationSettings :form="form" />
          <CommandSettings v-if="isNative" v-model:terminal="terminalCmd" v-model:editor="editorCmd" />
        </form>
      </div>
    </div>

    <template #footer>
      <p v-if="failure" class="form-error min-w-0 truncate" :title="failure">{{ failure }}</p>
      <template v-if="form">
        <button type="button" :disabled="saving" @click="test">Save &amp; send a test notification</button>
        <span class="text-muted">{{ tested }}</span>
      </template>
      <span class="spacer" />
      <button type="button" @click="$emit('close')">Cancel</button>
      <button class="primary" type="submit" form="settings-form" :disabled="saving || !form">Save</button>
    </template>
  </Modal>
</template>
