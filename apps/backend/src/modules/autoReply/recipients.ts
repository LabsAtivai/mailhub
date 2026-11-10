import { z } from 'zod'

// testRecipient guarda um ou vários e-mails separados por vírgula, ponto e vírgula ou espaço.
// Em modo test a resposta do agente vai para todos eles (equipe revisando os testes).
export function parseRecipients(value: string | null | undefined): string[] {
  const seen = new Set<string>()
  for (const part of (value ?? '').split(/[\s,;]+/)) {
    const email = part.trim().toLowerCase()
    if (email) seen.add(email)
  }
  return [...seen]
}

const emailSchema = z.string().email()

export const TestRecipientSchema = z.string().max(500).refine(v => {
  const list = parseRecipients(v)
  return list.length >= 1 && list.length <= 10 && list.every(e => emailSchema.safeParse(e).success)
}, { message: 'Informe de 1 a 10 e-mails válidos separados por vírgula' })
