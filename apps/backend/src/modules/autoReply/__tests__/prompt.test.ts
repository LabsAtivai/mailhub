import { describe, expect, it } from 'vitest'
import { AGENT_SYSTEM_INSTRUCTIONS, buildAgentPrompt } from '../prompt'

describe('prompt do agente', () => {
  it('responde no idioma do e-mail recebido, não fixa português', () => {
    expect(AGENT_SYSTEM_INSTRUCTIONS).toContain('IDIOMA: responda no mesmo idioma')
    expect(AGENT_SYSTEM_INSTRUCTIONS).not.toContain('Sempre escrever em português do Brasil')
  })

  it('mantém o e-mail recebido e a assinatura no prompt do usuário', () => {
    const p = buildAgentPrompt({
      subject: 'Cleaning quote', body: 'Hi, do you clean med spas?', signature: 'Andrea Macedo',
      clientContext: 'Empresa representada: Solution.',
    })
    expect(p).toContain('Hi, do you clean med spas?')
    expect(p).toContain('Andrea Macedo')
  })
})
