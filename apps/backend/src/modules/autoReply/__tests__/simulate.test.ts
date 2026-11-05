import { describe, it, expect, vi, beforeEach } from 'vitest'

const findConfig = vi.fn()
const findAccount = vi.fn()

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    autoReplyConfig: { findUnique: (...a: unknown[]) => findConfig(...a) },
    mailAccount: { findUnique: (...a: unknown[]) => findAccount(...a) },
    autoReplyLog: { create: vi.fn(), update: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  },
}))
vi.mock('../../../lib/redis', () => ({ redis: { publish: vi.fn() } }))
vi.mock('../../ai/openaiClient', () => ({ generateWithInstructions: vi.fn() }))
vi.mock('../../messages/useCases', () => ({ messageUseCases: { send: vi.fn() } }))

import { simulateIncoming, SimulationError } from '../agent'

const input = { fromEmail: 'lead@exemplo.com', subject: 'Re: Oi', body: 'Tenho interesse' }

describe('simulateIncoming: travas', () => {
  beforeEach(() => {
    findConfig.mockReset(); findAccount.mockReset()
    process.env.AUTOREPLY_ENABLED = 'true'
  })

  it('recusa quando o kill switch global está desligado', async () => {
    process.env.AUTOREPLY_ENABLED = 'false'
    await expect(simulateIncoming('a', input)).rejects.toBeInstanceOf(SimulationError)
  })

  it('recusa caixa sem configuração ou em modo off', async () => {
    findConfig.mockResolvedValue(null)
    await expect(simulateIncoming('a', input)).rejects.toThrow(/sem agente/i)
    findConfig.mockResolvedValue({ mode: 'off' })
    await expect(simulateIncoming('a', input)).rejects.toThrow(/sem agente/i)
  })

  it('nunca simula em modo live', async () => {
    findConfig.mockResolvedValue({ mode: 'live' })
    await expect(simulateIncoming('a', input)).rejects.toThrow(/live/)
    expect(findAccount).not.toHaveBeenCalled()
  })

  it('exige testRecipient no modo test', async () => {
    findConfig.mockResolvedValue({ mode: 'test', testRecipient: null })
    await expect(simulateIncoming('a', input)).rejects.toThrow(/testRecipient/)
  })
})
