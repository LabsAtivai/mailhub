import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../services/api'
import { disconnectSocket } from '../services/socket'

export interface AuthUser { id: string; name: string; email: string; role?: string }

export const useAuthStore = defineStore('auth', () => {
  const user = ref<AuthUser | null>(null)
  const isLoggedIn = computed(() => !!user.value)
  const isAdmin = computed(() => user.value?.role === 'admin')

  async function init() {
    const access = localStorage.getItem('access')
    if (!access) return
    try {
      const { data } = await api.get('/auth/me')
      user.value = data
    } catch { logout() }
  }

  async function login(email: string, password: string) {
    const { data } = await api.post('/auth/login', { email, password })
    localStorage.setItem('access', data.access)
    localStorage.setItem('refresh', data.refresh)
    user.value = data.user
  }

  async function register(name: string, email: string, password: string) {
    const { data } = await api.post('/auth/register', { name, email, password })
    localStorage.setItem('access', data.access)
    localStorage.setItem('refresh', data.refresh)
    user.value = data.user
  }

  function logout() {
    const refresh = localStorage.getItem('refresh')
    if (refresh) api.post('/auth/logout', { refresh }).catch(() => {})
    localStorage.removeItem('access')
    localStorage.removeItem('refresh')
    user.value = null
    disconnectSocket()
  }

  return { user, isLoggedIn, isAdmin, init, login, register, logout }
})
