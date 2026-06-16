import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  server: {
    port: 5173,
    proxy: {
      '/auth': 'http://localhost:3001',
      '/accounts': 'http://localhost:3001',
      '/folders': 'http://localhost:3001',
      '/messages': 'http://localhost:3001',
    }
  }
})
