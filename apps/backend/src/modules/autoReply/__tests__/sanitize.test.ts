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

import { extractAttachFlag, ATTACH_PRESENTATION_TOKEN, buildAgentPrompt } from '../prompt'

describe('anexo da apresentação', () => {
  it('remove o marcador e sinaliza o anexo', () => {
    const r = extractAttachFlag(`Segue a apresentação em anexo. Qual sua disponibilidade?\n\n${ATTACH_PRESENTATION_TOKEN}`)
    expect(r.attach).toBe(true)
    expect(r.text).not.toContain('[[')
    expect(extractAttachFlag('Olá, tudo bem?').attach).toBe(false)
  })
  it('só lista arquivo no prompt quando existe', () => {
    const base = { subject: 's', body: 'b', signature: 'x', clientContext: 'c' }
    expect(buildAgentPrompt({ ...base, attachmentName: 'apresentacao.pdf' })).toContain('apresentacao.pdf')
    expect(buildAgentPrompt(base)).toContain('não mencione anexo')
  })
})
