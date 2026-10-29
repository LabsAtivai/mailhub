import { describe, it, expect } from 'vitest'
import { isAutomatic, isSelf, looksLikeOptOut, threadKeyOf, unwrapForwarded } from '../filters'

describe('autoReply filters', () => {
  it('detecta remetentes automáticos', () => {
    expect(isAutomatic('noreply@x.com', 'Oi')).toBe('noreply')
    expect(isAutomatic('a@titan.email', 'Oi')).toBe('noreply')
    expect(isAutomatic('a@x.com', 'Auto-Resposta')).toBe('automatic')
    expect(isAutomatic('lead@x.com', 'Re: Convite: Reunião')).toBeNull()
  })
  it('detecta a própria caixa', () => {
    expect(isSelf('Contato@Ativa.live', 'contato@ativa.live')).toBe(true)
  })
  it('detecta opt-out', () => {
    expect(looksLikeOptOut('Por favor me remova da lista, não quero receber')).toBe(true)
    expect(looksLikeOptOut('Tenho interesse, vamos marcar?')).toBe(false)
  })
  it('normaliza chave de thread', () => {
    expect(threadKeyOf('RES: Re: Convite: Reunião')).toBe('convite: reunião')
  })
  it('extrai remetente original de reenvio de teste', () => {
    const body = [
      '---------- Mensagem recebida (reenvio de teste) ----------',
      'De:  <lead@empresa.com>', 'Para: x', 'Data: d', 'Assunto original: RE: Proposta', 'Caixa de origem: a@b.com',
      '----------------------------------------------------------', '', 'Olá, tenho interesse.',
    ].join('\n')
    expect(unwrapForwarded(body)).toEqual({ fromEmail: 'lead@empresa.com', subject: 'RE: Proposta', body: 'Olá, tenho interesse.' })
    expect(unwrapForwarded('texto normal')).toBeNull()
  })
})
