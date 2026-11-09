<script setup lang="ts">
import { DropdownMenuRadioGroup } from 'reka-ui';

// A set of MenuRadioItems where one is picked. `v-model` is the picked item's value.
const model = defineModel<string>({ default: '' });
</script>

<template>
  <DropdownMenuRadioGroup v-model="model"><slot /></DropdownMenuRadioGroup>
</template>
