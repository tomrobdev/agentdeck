<script setup lang="ts">
import type { NotificationRow } from '../../../api/types';
import { ago } from '../../../lib/shared/time';
import Chip from '../../ui/Chip.vue';

// The latest alerts the daemon sent.
defineProps<{ notifications: NotificationRow[] }>();

/** An alert's chip tone: a budget or pause alert looks like a blocked task. */
function alertTone(kind: NotificationRow['kind']) {
  return kind === 'hold' || kind === 'paused' ? 'blocked' : kind;
}
</script>

<template>
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
</template>
