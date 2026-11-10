import { describe, expect, it } from 'vitest'
import { isNoiseMessage } from '../../messages/noiseFilter'

describe('ruído descartado em silêncio pelo respondedor', () => {
  it('warmup (WRM) no assunto é ruído, em qualquer caixa', () => {
    expect(isNoiseMessage({ subject: 'Re: Reunião rápida (WRM)', fromEmail: 'alguem@dominio.com' })).toBe(true)
    expect(isNoiseMessage({ subject: 'follow [wrm] 123', fromEmail: 'alguem@dominio.com' })).toBe(true)
  })

  it('resposta automática, teste do Snov e remetentes técnicos são ruído', () => {
    expect(isNoiseMessage({ subject: 'Resposta automática: férias', fromEmail: 'a@b.com' })).toBe(true)
    expect(isNoiseMessage({ subject: 'Testing your new email with Snov.io', fromEmail: 'a@b.com' })).toBe(true)
    expect(isNoiseMessage({ subject: 'Oi', fromEmail: 'NoReply@empresa.com' })).toBe(true)
    expect(isNoiseMessage({ subject: 'Oi', fromEmail: 'mailer-daemon@x.com' })).toBe(true)
  })

  it('lead real não é ruído', () => {
    expect(isNoiseMessage({ subject: 'Re: Apresentação | VTCall', fromEmail: 'maria@cliente.com.br' })).toBe(false)
    expect(isNoiseMessage({ subject: null, fromEmail: null })).toBe(false)
  })
})
