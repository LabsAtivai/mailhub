<template>
  <RouterView />
  <Toast position="top-right" />
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router'
import Toast from 'primevue/toast'
</script>

<style>
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: 'Inter', system-ui, sans-serif; }
</style>
