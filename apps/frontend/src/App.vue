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
body {
  margin: 0;
  font-family: 'Montserrat', system-ui, sans-serif;
  color: #111111;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
a { color: #F47A20; }
a:hover { color: #EA680C; }
</style>
