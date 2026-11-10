import { describe, expect, it } from 'vitest'
import { parseRecipients, TestRecipientSchema } from '../recipients'

describe('testRecipient com vários e-mails', () => {
  it('separa por vírgula, ponto e vírgula e espaço, sem duplicar', () => {
    expect(parseRecipients('A@x.com, b@x.com;c@x.com  a@x.com\n')).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
    expect(parseRecipients(null)).toEqual([])
  })

  it('aceita 1 a 10 e-mails válidos', () => {
    expect(TestRecipientSchema.safeParse('a@x.com').success).toBe(true)
    expect(TestRecipientSchema.safeParse('a@x.com, b@x.com').success).toBe(true)
  })

  it('recusa lista vazia, e-mail inválido e mais de 10', () => {
    expect(TestRecipientSchema.safeParse('  ').success).toBe(false)
    expect(TestRecipientSchema.safeParse('a@x.com, nao-e-email').success).toBe(false)
    const onze = Array.from({ length: 11 }, (_, i) => `u${i}@x.com`).join(',')
    expect(TestRecipientSchema.safeParse(onze).success).toBe(false)
  })
})
