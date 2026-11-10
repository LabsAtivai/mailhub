import { describe, expect, it } from 'vitest'
import { detectLanguage, languageDirective } from '../language'
import { buildAgentPrompt } from '../prompt'
import { buildReferralIntroPrompt } from '../referralPrompt'

describe('idioma do e-mail recebido', () => {
  it('detecta inglês, português e espanhol', () => {
    expect(detectLanguage('Question about your service\n\nDo you clean med spas in Wellington, and do you guarantee a minimum number of weekly visits?')).toBe('en')
    expect(detectLanguage('Thanks for reaching out. Please talk to Mark Dunn. He handles our facilities.')).toBe('en')
    expect(detectLanguage('Olá, tenho interesse e gostaria de saber como funciona para a nossa empresa. Podem me enviar mais detalhes?')).toBe('pt')
    expect(detectLanguage('Hola, gracias por el contacto. Tengo interés y quisiera saber más sobre su empresa para nuestro equipo.')).toBe('es')
  })

  it('não adivinha com pouco texto ou texto ambíguo', () => {
    expect(detectLanguage('ok')).toBe('unknown')
    expect(detectLanguage('')).toBe('unknown')
  })

  it('só pede outro idioma quando não é português', () => {
    expect(languageDirective('pt')).toBe('')
    expect(languageDirective('unknown')).toBe('')
    expect(languageDirective('en')).toContain('em inglês')
  })

  it('o pedido ao modelo leva a diretiva de idioma', () => {
    const p = buildAgentPrompt({ subject: 's', body: 'b', signature: 'Andrea', clientContext: 'ctx', language: 'en' })
    expect(p).toContain('IDIOMA DA RESPOSTA')
    const intro = buildReferralIntroPrompt({ subject: 's', body: 'b', signature: 'Andrea', clientContext: 'ctx', senderEmail: 'a@b.com', referredEmail: 'c@d.com', language: 'en' })
    expect(intro).toContain('IDIOMA DA RESPOSTA')
    expect(buildAgentPrompt({ subject: 's', body: 'b', signature: 'A', clientContext: 'c' })).not.toContain('IDIOMA DA RESPOSTA')
  })
})
