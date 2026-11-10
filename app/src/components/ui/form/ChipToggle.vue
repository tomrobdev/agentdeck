<script setup lang="ts">
import { Toggle } from 'reka-ui';
import type { Tone } from '../../../lib/shared/tone';
import Chip from '../Chip.vue';

defineProps<{ tone?: Tone }>();
const on = defineModel<boolean>({ required: true });
</script>

<template>
  <Toggle v-model="on" as-child>
    <Chip as="button" :tone="on ? (tone ?? 'accent') : 'muted'" :variant="on ? 'tint' : 'outline'"><slot /></Chip>
  </Toggle>
</template>
