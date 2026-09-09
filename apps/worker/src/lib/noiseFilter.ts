// Espelho de apps/backend/src/modules/messages/noiseFilter.ts — sem
// packages/shared entre os repos (ver CLAUDE.md), então essa lista precisa
// ser mantida igual nos dois lugares manualmente. Usado só pra refreshCounts
// não contar como "não lido" o que a listagem do backend já esconde; IMAP e
// a mensagem em si continuam intactos.
const NOISE_SUBJECT_CONTAINS = [
  '(WRM)',
  '[WRM]',
  'Testing your new email with Snov.io',
  'Resposta automatica',
  'Resposta automática',
]

const NOISE_FROM_CONTAINS = [
  'ironport-notify@',
  'noreply@',
  'postmaster@',
  'mailer-daemon@',
  'postmastercloud@',
  'mimecast-noreply@',
  'emailsecurity@',
  'cloudhq.net',
  'cloudhq.us',
  'cloudhq.io',
  'cloudhq-mkt11.us',
  'cloudhq-mkt12.us',
  'mailking',
]

// Endereços de tracking próprios (ex: BCC-to-self de ferramenta de
// prospecção) — cópias endereçadas a eles são ruído, não e-mail de verdade.
const NOISE_TO_CONTAINS = [
  'coopercarga.ativa+track@gmail.com',
]

export function excludeNoiseWhere(): Record<string, unknown> {
  return {
    AND: [
      ...NOISE_SUBJECT_CONTAINS.map(s => ({ NOT: { subject: { contains: s, mode: 'insensitive' } } })),
      ...NOISE_FROM_CONTAINS.map(s => ({ NOT: { fromEmail: { contains: s, mode: 'insensitive' } } })),
      ...NOISE_TO_CONTAINS.map(s => ({ NOT: { toJson: { contains: s, mode: 'insensitive' } } })),
    ],
  }
}
