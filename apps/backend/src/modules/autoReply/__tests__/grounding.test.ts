import { describe, it, expect, vi, beforeEach } from 'vitest'

const gen = vi.fn()
vi.mock('../../ai/openaiClient', () => ({ generateWithInstructions: (...a: unknown[]) => gen(...a) }))

import { groundDraft, parseUnsupported } from '../grounding'

const ctx = { context: 'A Avell fabrica notebooks de alto desempenho.', received: 'Vocês têm garantia estendida?', draft: 'Sim, temos garantia estendida.\n\nEduardo' }

describe('verificação de fatos do rascunho', () => {
  beforeEach(() => gen.mockReset())

  it('lê a lista de afirmações sem base, mesmo em bloco de código', () => {
    expect(parseUnsupported('```json\n{"nao_sustentadas":["garantia estendida"]}\n```')).toEqual(['garantia estendida'])
    expect(parseUnsupported('{"nao_sustentadas":[]}')).toEqual([])
    expect(parseUnsupported('texto sem json')).toBeNull()
    expect(parseUnsupported('{"outro":1}')).toBeNull()
  })

  it('rascunho sustentado passa sem reescrever', async () => {
    gen.mockResolvedValueOnce('{"nao_sustentadas":[]}')
    const r = await groundDraft(ctx)
    expect(r).toMatchObject({ draft: ctx.draft, unsupported: [], checked: true, rewritten: false })
    expect(gen).toHaveBeenCalledTimes(1)
  })

  it('afirmação sem base é reescrita e conferida de novo', async () => {
    gen.mockResolvedValueOnce('{"nao_sustentadas":["garantia estendida"]}')
      .mockResolvedValueOnce('Vou confirmar a garantia com a equipe e retorno.\n\nEduardo')
      .mockResolvedValueOnce('{"nao_sustentadas":[]}')
    const r = await groundDraft(ctx)
    expect(r.draft).toContain('Vou confirmar')
    expect(r).toMatchObject({ unsupported: [], checked: true, rewritten: true })
    expect(gen).toHaveBeenCalledTimes(3)
  })

  it('o que sobrar depois da reescrita continua marcado', async () => {
    gen.mockResolvedValueOnce('{"nao_sustentadas":["garantia estendida"]}')
      .mockResolvedValueOnce('Temos garantia estendida sim.')
      .mockResolvedValueOnce('{"nao_sustentadas":["garantia estendida"]}')
    const r = await groundDraft(ctx)
    expect(r.unsupported).toEqual(['garantia estendida'])
  })

  it('falha do verificador não passa como aprovado', async () => {
    gen.mockRejectedValueOnce(new Error('timeout'))
    const r = await groundDraft(ctx)
    expect(r).toMatchObject({ checked: false, rewritten: false, draft: ctx.draft })
  })
})
