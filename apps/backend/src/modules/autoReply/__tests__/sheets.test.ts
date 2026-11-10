import { describe, it, expect } from 'vitest'
import { buildRow, sheetsConfigured, appendPhoneReferral } from '../sheets'

const row = { date: new Date('2026-11-10T15:00:00Z'), client: 'VTCall', mailbox: 'tabata@mktvtcall.com.br', referrer: 'maria@lead.com', subject: 'Reunião', name: '', phone: '(11) 98765-4321', mode: 'live' }

describe('planilha de indicações só com telefone', () => {
  it('monta a linha com data de Brasília e nome padrão quando não há', () => {
    const r = buildRow(row)
    expect(r).toHaveLength(8)
    expect(r[0]).toMatch(/10\/11\/2026/)
    expect(r.slice(1)).toEqual(['VTCall', 'tabata@mktvtcall.com.br', 'maria@lead.com', 'Reunião', '(sem nome)', '(11) 98765-4321', 'live'])
  })

  it('sem configuração não falha: devolve false', async () => {
    delete process.env.REFERRAL_SHEET_ID
    delete process.env.GOOGLE_SA_JSON_B64
    expect(sheetsConfigured()).toBe(false)
    await expect(appendPhoneReferral(row)).resolves.toBe(false)
  })
})
