import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMailStore } from '../mail'
import { api } from '../../services/api'

vi.mock('../../services/api', () => ({
  api: { delete: vi.fn(), get: vi.fn(), post: vi.fn(), patch: vi.fn() }
}))
vi.mock('../../services/socket', () => ({
  getSocket: vi.fn(), isSocketInitialized: vi.fn(() => true), setSocketInitialized: vi.fn()
}))

describe('mail store bulkDelete', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.delete).mockReset()
  })

  it('reporta 0 falhas quando todas as exclusoes funcionam', async () => {
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    const mail = useMailStore()
    const result = await mail.bulkDelete(['a', 'b', 'c'])
    expect(result).toEqual({ total: 3, failed: 0 })
  })

  it('conta falhas parciais em vez de deixar o Promise.all rejeitar tudo', async () => {
    vi.mocked(api.delete).mockImplementation((url: string) => {
      if (url === '/messages/b') return Promise.reject(new Error('boom'))
      return Promise.resolve({ data: {} })
    })
    const mail = useMailStore()
    const result = await mail.bulkDelete(['a', 'b', 'c'])
    expect(result).toEqual({ total: 3, failed: 1 })
  })

  it('limpa a selecao mesmo quando alguma exclusao falha', async () => {
    vi.mocked(api.delete).mockRejectedValue(new Error('boom'))
    const mail = useMailStore()
    mail.selectedIds = new Set(['a', 'b'])
    await mail.bulkDelete(['a', 'b'])
    expect(mail.selectedIds.size).toBe(0)
  })
})
