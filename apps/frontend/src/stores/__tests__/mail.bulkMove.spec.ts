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

describe('mail store bulkMove', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.post).mockReset()
  })

  it('envia o folderId de destino e reporta 0 falhas', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { ok: true } })
    const mail = useMailStore()
    const result = await mail.bulkMove(['a', 'b'], 'inbox-id')
    expect(result).toEqual({ total: 2, failed: 0 })
    expect(api.post).toHaveBeenCalledWith('/messages/a/move', { folderId: 'inbox-id' })
  })

  it('conta falhas parciais e limpa a selecao', async () => {
    vi.mocked(api.post).mockImplementation((url: string) => {
      if (url === '/messages/b/move') return Promise.reject(new Error('boom'))
      return Promise.resolve({ data: { ok: true } })
    })
    const mail = useMailStore()
    mail.selectedIds = new Set(['a', 'b', 'c'])
    const result = await mail.bulkMove(['a', 'b', 'c'], 'inbox-id')
    expect(result).toEqual({ total: 3, failed: 1 })
    expect(mail.selectedIds.size).toBe(0)
  })

  it('inboxFolderIdFor acha a INBOX mesmo sem specialUse', () => {
    const mail = useMailStore()
    mail.foldersByAccount = {
      acc: [
        { id: 'j', path: 'Junk', name: 'Junk', specialUse: '\\Junk' },
        { id: 'i', path: 'INBOX', name: 'INBOX', specialUse: null },
      ],
    } as never
    expect(mail.inboxFolderIdFor('acc')).toBe('i')
    expect(mail.inboxFolderIdFor('outra')).toBeNull()
  })
})
