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

const ok = (failedIds: string[] = []) => Promise.resolve({ data: { ok: true, queued: 0, failedIds } })

describe('mail store bulkMove', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.post).mockReset()
  })

  it('envia um unico POST em lote com o folderId de destino', async () => {
    vi.mocked(api.post).mockImplementation(() => ok())
    const mail = useMailStore()
    const result = await mail.bulkMove(['a', 'b'], 'inbox-id')
    expect(result).toEqual({ total: 2, failed: 0, failedIds: [] })
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post).toHaveBeenCalledWith('/messages/move-batch', { messageIds: ['a', 'b'], folderId: 'inbox-id' })
  })

  it('mantem selecionadas as mensagens que falharam', async () => {
    vi.mocked(api.post).mockImplementation(() => ok(['b']))
    const mail = useMailStore()
    mail.selectedIds = new Set(['a', 'b', 'c'])
    const result = await mail.bulkMove(['a', 'b', 'c'], 'inbox-id')
    expect(result).toEqual({ total: 3, failed: 1, failedIds: ['b'] })
    expect([...mail.selectedIds]).toEqual(['b'])
  })

  it('divide em lotes de 100 enviados em serie', async () => {
    let running = 0
    let maxRunning = 0
    vi.mocked(api.post).mockImplementation(async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await Promise.resolve()
      running--
      return { data: { ok: true, queued: 0, failedIds: [] } }
    })
    const mail = useMailStore()
    const ids = Array.from({ length: 250 }, (_, i) => `m${i}`)
    await mail.bulkMove(ids, 'inbox-id')
    const sizes = vi.mocked(api.post).mock.calls.map(c => (c[1] as { messageIds: string[] }).messageIds.length)
    expect(sizes).toEqual([100, 100, 50])
    expect(maxRunning).toBe(1)
  })

  it('erro de rede num lote marca so aqueles ids como falhos', async () => {
    vi.mocked(api.post)
      .mockImplementationOnce(() => ok())
      .mockRejectedValueOnce(new Error('boom'))
    const mail = useMailStore()
    const ids = Array.from({ length: 150 }, (_, i) => `m${i}`)
    const result = await mail.bulkMove(ids, 'inbox-id')
    expect(result.failed).toBe(50)
    expect(result.failedIds).toEqual(ids.slice(100))
    expect(mail.selectedIds.size).toBe(50)
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
