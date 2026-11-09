<script setup lang="ts">
import { AccordionContent, AccordionHeader, AccordionItem } from 'reka-ui';

// One part of an Accordion: a header row (put an AccordionTrigger in it) and the content that opens under it.
defineProps<{ value: string; as?: string; headerClass?: string }>();
</script>

<template>
  <AccordionItem :value="value" :as="as">
    <AccordionHeader as="div" :class="headerClass"><slot name="header" /></AccordionHeader>
    <AccordionContent><slot /></AccordionContent>
  </AccordionItem>
</template>
