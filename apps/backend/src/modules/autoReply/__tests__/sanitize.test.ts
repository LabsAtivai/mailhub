import { describe, it, expect } from 'vitest'
import { sanitizeEmailBody, cleanupFinalEmail } from '../sanitize'
import { AGENT_SYSTEM_INSTRUCTIONS, NO_REPLY_TOKEN } from '../prompt'

describe('autoReply sanitize e prompt', () => {
  it('remove histórico citado e linhas repetidas', () => {
    const body = 'Tenho interesse.\nTenho interesse.\n> texto citado\nEm seg, 26 out escreveu:\nmensagem antiga'
    expect(sanitizeEmailBody(body, 1000)).toBe('Tenho interesse.')
  })
  it('limpa rótulos de diagnóstico da saída', () => {
    expect(cleanupFinalEmail('Assunto: x\nCategoria: lead\nOlá, tudo bem?')).toBe('Olá, tudo bem?')
  })
  it('prompt traz as seções do painel e o token de silêncio', () => {
    for (const k of ['PERSUASÃO COMERCIAL', 'CTA:', 'REGRA CENTRAL DE USO DO CONTEXTO', 'HORÁRIOS (REGRA RÍGIDA)', 'PEDIDO DE REMOÇÃO']) {
      expect(AGENT_SYSTEM_INSTRUCTIONS).toContain(k)
    }
    expect(AGENT_SYSTEM_INSTRUCTIONS).toContain(NO_REPLY_TOKEN)
  })
})
