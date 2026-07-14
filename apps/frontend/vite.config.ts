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
      // regex (não prefixo simples): "/admin" sozinho é a tela do SPA (Vue
      // Router), só "/admin/..." é API — a barra final evita a rota da tela
      // cair no proxy e devolver o 401 da API em vez do index.html.
      '^/admin/': 'http://localhost:3001',
      '/accounts': 'http://localhost:3001',
      '/folders': 'http://localhost:3001',
      '/messages': 'http://localhost:3001',
      '/labels': 'http://localhost:3001',
      '/attachments': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    }
  }
})
