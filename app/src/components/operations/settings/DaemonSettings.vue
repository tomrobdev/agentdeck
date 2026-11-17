<script setup lang="ts">
import type { ServiceStatus } from '#api/types.ts';
import type { SettingsForm } from '#lib/shared/forms.ts';
import { isNative } from '#platform/native.ts';
import Chip from '#components/ui/Chip.vue';
import Switch from '#components/ui/form/Switch.vue';

defineProps<{ form: SettingsForm; service: ServiceStatus | null; appAtLogin: boolean | null }>();
defineEmits<{ toggleAppAtLogin: [] }>();
</script>

<template>
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
    <Switch v-if="isNative" :model-value="!!appAtLogin" @update:model-value="$emit('toggleAppAtLogin')">
      Open this dashboard at login (in the menu bar)
    </Switch>
  </section>
</template>
