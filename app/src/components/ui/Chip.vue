<script setup lang="ts">
import { computed } from 'vue';
import { type Tone, statusTone } from '#lib/shared/tone.ts';

const props = withDefaults(
  defineProps<{
    tone?: Tone;
    status?: string;
    variant?: 'outline' | 'tint' | 'solid';
    size?: 'xs' | 'sm';
    dot?: boolean;
    removable?: boolean;
    removeLabel?: string;
    as?: string;
  }>(),
  { tone: 'muted', variant: 'outline', size: 'sm', removeLabel: 'Remove', as: 'span' },
);
defineEmits<{ remove: [] }>();

const toneName = computed(() => (props.status ? statusTone(props.status) : props.tone));
</script>

<template>
  <component
    :is="as"
    class="ui-chip"
    :class="[`tone-${toneName}`, `v-${variant}`, `sz-${size}`]"
    :type="as === 'button' ? 'button' : undefined"
  >
    <span v-if="dot" class="ui-chip-dot" aria-hidden="true" />
    <slot />
    <button v-if="removable" type="button" class="ui-chip-x" :aria-label="removeLabel" @click.stop="$emit('remove')">✕</button>
  </component>
</template>

<style scoped>
.ui-chip {
  --tone: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: var(--r-chip, 999px);
  background: transparent;
  color: var(--tone);
  white-space: nowrap;
  font-family: inherit;
}
.sz-xs {
  font-size: 11px;
  line-height: 17px;
}
.sz-sm {
  font-size: 12px;
  line-height: 20px;
  padding: 0 8px;
}
.tone-accent {
  --tone: var(--accent);
}
.tone-running {
  --tone: var(--running);
}
.tone-done {
  --tone: var(--done);
}
.tone-blocked {
  --tone: var(--blocked);
}
.tone-failed {
  --tone: var(--failed);
}
.tone-merged {
  --tone: var(--merged);
}
.tone-queued {
  --tone: var(--queued);
}
.tone-cancelled {
  --tone: var(--cancelled);
}
.v-outline {
  border-color: color-mix(in srgb, var(--tone) var(--chip-mix, 45%), transparent);
}
.v-tint {
  background: color-mix(in srgb, var(--tone) var(--chip-tint, 14%), transparent);
}
.v-solid {
  background: var(--tone);
  color: var(--bg);
}
:root[data-theme='contrast'] .ui-chip {
  background: transparent;
  border-color: var(--tone);
  color: var(--tone);
}
button.ui-chip {
  cursor: pointer;
}
button.ui-chip[aria-pressed='true'],
button.ui-chip[data-state='on'] {
  font-weight: 600;
}
.ui-chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}
.ui-chip-x {
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0 2px;
  font-size: 0.9em;
  line-height: 1;
  opacity: 0.7;
  cursor: pointer;
}
.ui-chip-x:hover {
  opacity: 1;
}
</style>
