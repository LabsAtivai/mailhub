import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'

const publish = vi.hoisted(() => vi.fn())
const repo = vi.hoisted(() => ({
  findMessageWithOwner: vi.fn(),
  findFolderWithOwner: vi.fn(),
}))

vi.mock('../../../lib/redis', () => ({ redis: { publish } }))
vi.mock('../../../lib/crypto', () => ({ decrypt: vi.fn(), encrypt: vi.fn() }))
vi.mock('../../../lib/accountActivity', () => ({ touchAccountActivity: vi.fn() }))
vi.mock('../repository', () => ({ messageRepository: repo }))
vi.mock('../../../middleware/auth', () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => { req.userId = 'user-1'; next() },
}))

import router from '../routes'
import { messageUseCases as uc, ValidationError } from '../useCases'

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const MSG_A = U(1), MSG_B = U(2), MSG_C = U(3)
const INBOX = U(10), SPAM = U(11), OTHER_ACCOUNT_INBOX = U(12)

const message = (id: string, folderId: string, accountId = 'acc-1', userId = 'user-1') => ({
  id, folderId, uid: BigInt(Number(id.slice(-2))), folder: { account: { id: accountId, userId } },
})
const folder = (id: string, accountId: string, userId = 'user-1') => ({ id, account: { id: accountId, userId } })

beforeEach(() => {
  publish.mockReset()
  repo.findMessageWithOwner.mockReset()
  repo.findFolderWithOwner.mockReset()
  repo.findFolderWithOwner.mockImplementation(async (id: string) =>
    id === INBOX ? folder(INBOX, 'acc-1')
      : id === OTHER_ACCOUNT_INBOX ? folder(OTHER_ACCOUNT_INBOX, 'acc-2')
        : null)
})

describe('messageUseCases.move', () => {
  it('rejeita mover para pasta de outra conta e nao publica nada', async () => {
    repo.findMessageWithOwner.mockResolvedValue(message(MSG_A, SPAM))
    await expect(uc.move(MSG_A, 'user-1', OTHER_ACCOUNT_INBOX)).rejects.toBeInstanceOf(ValidationError)
    expect(publish).not.toHaveBeenCalled()
  })

  it('publica o move quando a pasta e da mesma conta', async () => {
    repo.findMessageWithOwner.mockResolvedValue(message(MSG_A, SPAM))
    await uc.move(MSG_A, 'user-1', INBOX)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0][0]).toBe('mailhub:message:move')
  })
})

describe('messageUseCases.moveBatch', () => {
  it('agrupa por pasta de origem e manda invalidas em failedIds', async () => {
    const rows: Record<string, unknown> = {
      [MSG_A]: message(MSG_A, SPAM),
      [MSG_B]: message(MSG_B, SPAM),
      [MSG_C]: message(MSG_C, SPAM, 'acc-2'), // outra conta
    }
    repo.findMessageWithOwner.mockImplementation(async (id: string) => rows[id] ?? null)
    const missing = U(99)

    const result = await uc.moveBatch([MSG_A, MSG_B, MSG_C, missing], 'user-1', INBOX)

    expect(result).toEqual({ queued: 2, failedIds: [MSG_C, missing] })
    expect(publish).toHaveBeenCalledTimes(1)
    const [channel, payload] = publish.mock.calls[0]
    expect(channel).toBe('mailhub:message:moveBatch')
    expect(JSON.parse(payload).items.map((i: { messageId: string }) => i.messageId)).toEqual([MSG_A, MSG_B])
  })

  it('nao move mensagem que ja esta na pasta de destino', async () => {
    repo.findMessageWithOwner.mockResolvedValue(message(MSG_A, INBOX))
    const result = await uc.moveBatch([MSG_A], 'user-1', INBOX)
    expect(result).toEqual({ queued: 0, failedIds: [MSG_A] })
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('POST /messages/:id/move (rota)', () => {
  const app = express()
  app.use(express.json())
  app.use(router)
  const server = app.listen(0)
  const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  afterAll(() => { server.close() })

  const post = (path: string, body: unknown) => fetch(`${base()}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  it('devolve 400 ao mover para pasta de outra conta', async () => {
    repo.findMessageWithOwner.mockResolvedValue(message(MSG_A, SPAM))
    const res = await post(`/messages/${MSG_A}/move`, { folderId: OTHER_ACCOUNT_INBOX })
    expect(res.status).toBe(400)
    expect(publish).not.toHaveBeenCalled()
  })

  it('devolve 400 no lote com mais de 100 ids', async () => {
    const messageIds = Array.from({ length: 101 }, (_, i) => U(1000 + i))
    const res = await post('/messages/move-batch', { messageIds, folderId: INBOX })
    expect(res.status).toBe(400)
  })

  it('lote valido responde queued e failedIds', async () => {
    repo.findMessageWithOwner.mockResolvedValue(message(MSG_A, SPAM))
    const res = await post('/messages/move-batch', { messageIds: [MSG_A], folderId: INBOX })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, queued: 1, failedIds: [] })
  })
})
