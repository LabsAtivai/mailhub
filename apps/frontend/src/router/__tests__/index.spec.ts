import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '../../stores/auth'

vi.mock('../../services/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }))
vi.mock('../../services/socket', () => ({ disconnectSocket: vi.fn() }))

async function buildRouter() {
  vi.resetModules()
  const mod = await import('../index')
  return mod.default
}

describe('router guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('redireciona para /login quando nao autenticado', async () => {
    const router = await buildRouter()
    await router.push('/admin')
    await router.isReady()
    expect(router.currentRoute.value.fullPath).toBe('/login')
  })

  it('bloqueia usuario comum logado de acessar /admin', async () => {
    localStorage.setItem('access', 'fake-token')
    const auth = useAuthStore()
    auth.user = { id: '1', name: 'User', email: 'u@x.com', role: 'user' }
    const router = await buildRouter()
    await router.push('/admin')
    await router.isReady()
    expect(router.currentRoute.value.fullPath).toBe('/')
  })

  it('permite admin logado acessar /admin', async () => {
    localStorage.setItem('access', 'fake-token')
    const auth = useAuthStore()
    auth.user = { id: '1', name: 'Admin', email: 'a@x.com', role: 'admin' }
    const router = await buildRouter()
    await router.push('/admin')
    await router.isReady()
    expect(router.currentRoute.value.fullPath).toBe('/admin')
  })
})
