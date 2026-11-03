<script setup lang="ts">
import { Toggle } from 'reka-ui';
import type { Tone } from '../../lib/tone';
import Chip from './Chip.vue';

// A Reka toggle drawn as a chip: tinted in its tone while on, an outline in muted while off.
defineProps<{ tone?: Tone }>();
const on = defineModel<boolean>({ required: true });
</script>

<template>
  <Toggle v-model="on" as-child>
    <Chip as="button" :tone="on ? (tone ?? 'accent') : 'muted'" :variant="on ? 'tint' : 'outline'"><slot /></Chip>
  </Toggle>
</template>
