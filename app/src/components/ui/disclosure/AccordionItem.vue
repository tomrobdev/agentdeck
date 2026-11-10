<script setup lang="ts">
import { AccordionContent, AccordionHeader, AccordionItem } from 'reka-ui';

defineProps<{ value: string; as?: string; headerClass?: string }>();
</script>

<template>
  <AccordionItem :value="value" :as="as">
    <AccordionHeader as="div" :class="headerClass"><slot name="header" /></AccordionHeader>
    <AccordionContent><slot /></AccordionContent>
  </AccordionItem>
</template>
