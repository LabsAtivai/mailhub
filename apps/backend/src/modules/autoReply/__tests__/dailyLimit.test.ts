import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/prisma', () => ({ prisma: {} }))
vi.mock('../../../lib/redis', () => ({ redis: { publish: vi.fn() } }))
vi.mock('../../ai/openaiClient', () => ({ generateWithInstructions: vi.fn() }))
vi.mock('../../messages/useCases', () => ({ messageUseCases: { send: vi.fn() } }))

import { dailyLimitStatuses } from '../agent'

describe('teto diário por modo', () => {
  it('em live conta só envio real e indicação em andamento', () => {
    const s = dailyLimitStatuses('live')
    expect(s).toContain('sent')
    expect(s).toContain('referral_pending')
    expect(s).not.toContain('shadow')
    expect(s).not.toContain('test_sent')
  })

  it('em shadow e test continua contando rascunhos e testes', () => {
    for (const mode of ['shadow', 'test']) {
      expect(dailyLimitStatuses(mode)).toEqual(expect.arrayContaining(['sent', 'shadow', 'test_sent']))
    }
  })
})
