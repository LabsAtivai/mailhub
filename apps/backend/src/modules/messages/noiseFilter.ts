// Ruído conhecido que nunca deve aparecer na visualização de e-mails (herdado
// dos filtros do Gmail antigo — ver relatorios/mailhub-mvp, filtro exportado
// do Gmail): warmup automático, bounces técnicos, notificação de segurança de
// e-mail corporativo e teste do Snov.io. IMAP continua fonte de verdade —
// isso só esconde da listagem, não apaga nem move nada.
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
