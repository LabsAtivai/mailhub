import { describe, it, expect, vi, beforeEach } from 'vitest'

const gen = vi.fn()
vi.mock('../../ai/openaiClient', () => ({ generateWithInstructions: (...a: unknown[]) => gen(...a) }))

import { groundDraft, parseUnsupported, quoteInContext } from '../grounding'

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

const CONTEXT = 'A Avell é uma marca brasileira especializada em notebooks de alto desempenho. Linha B.on: focada em produtividade, mobilidade e uso corporativo. CNPJ e e-mail do responsável financeiro omitidos de propósito.'

describe('revisor com evidência literal', () => {
  it('afirmação sem citação, ou com citação que não existe no contexto, é sem base', () => {
    const raw = JSON.stringify({ afirmacoes: [
      { afirmacao: 'vende para CNPJ com nota fiscal', evidencia: null },
      { afirmacao: 'oferece garantia estendida', evidencia: 'A Avell oferece garantia estendida de 3 anos em todos os modelos' },
      { afirmacao: 'marca brasileira de notebooks', evidencia: 'A Avell é uma marca brasileira especializada em notebooks de alto desempenho' },
    ] })
    expect(parseUnsupported(raw, CONTEXT)).toEqual(['vende para CNPJ com nota fiscal', 'oferece garantia estendida'])
  })

  it('a palavra CNPJ aparecendo em outro sentido não vale como evidência', () => {
    const raw = JSON.stringify({ afirmacoes: [{ afirmacao: 'vendemos para CNPJ', evidencia: 'CNPJ e e-mail' }] })
    expect(parseUnsupported(raw, CONTEXT)).toEqual(['vendemos para CNPJ'])
  })

  it('citação com acento ou pontuação diferente ainda é reconhecida', () => {
    expect(quoteInContext('linha b.on focada em produtividade mobilidade e uso corporativo', 'x ' + CONTEXT.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' '))).toBe(true)
    expect(quoteInContext('curta', 'curta demais')).toBe(false)
  })

  it('sem nenhuma afirmação factual, tudo sustentado', () => {
    expect(parseUnsupported('{"afirmacoes": []}', CONTEXT)).toEqual([])
  })

  it('o fluxo completo usa a citação: sem evidência real o rascunho é reescrito', async () => {
    gen.mockReset()
    gen.mockResolvedValueOnce(JSON.stringify({ afirmacoes: [{ afirmacao: 'nota fiscal para CNPJ', evidencia: 'emitimos nota fiscal para CNPJ' }] }))
      .mockResolvedValueOnce('Vou confirmar a nota fiscal com a equipe e retorno.')
      .mockResolvedValueOnce(JSON.stringify({ afirmacoes: [] }))
    const r = await groundDraft({ context: CONTEXT, received: 'Vendem para CNPJ?', draft: 'Sim, emitimos nota fiscal para CNPJ.' })
    expect(r).toMatchObject({ unsupported: [], rewritten: true, checked: true })
    expect(r.draft).toContain('Vou confirmar')
  })
})
