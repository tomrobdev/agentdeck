<script setup lang="ts">
import { NOTIFY_LABELS } from '../../api/format';
import { NOTIFY_KINDS, type SettingsForm } from '../../lib/shared/forms';
import Switch from '../ui/form/Switch.vue';

defineProps<{ form: SettingsForm }>();
</script>

<template>
  <section class="flex flex-col gap-2.5">
    <h4 class="m-0">Notifications</h4>
    <Switch v-model="form.desktop">macOS notifications</Switch>
    <div class="flex flex-wrap gap-x-4 gap-y-1.5">
      <label v-for="kind in NOTIFY_KINDS" :key="kind" class="flex items-center gap-2">
        <input type="checkbox" :value="kind" v-model="form.events" /> {{ NOTIFY_LABELS[kind] }}
      </label>
    </div>
    <label class="field">
      <span>ntfy topic for phone alerts <span class="text-muted">(optional)</span></span>
      <input v-model="form.ntfy_topic" placeholder="e.g. agentdeck-7f3k2" />
      <small class="text-muted text-xs">
        Install the ntfy app and subscribe to the same topic. Task titles are sent to ntfy.sh, and anyone who knows the topic name can read
        them, so pick something hard to guess.
      </small>
    </label>
  </section>
</template>
