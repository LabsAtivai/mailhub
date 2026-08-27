import { scope } from '../lib/logger'

const log = scope('report-mailer')

// Envio via API HTTP da SendGrid (fetch cru, sem nodemailer) — reaproveita a
// mesma SENDGRID_API_KEY que o forward de conta já usa no backend
// (apps/backend/src/index.ts), só que aqui como remetente de sistema, não de
// uma conta de usuário específica.
export async function sendReportEmail(dateKey: string, txt: string): Promise<void> {
  const apiKey = process.env.SENDGRID_API_KEY
  const from = process.env.REPORT_EMAIL_FROM
  const to = process.env.REPORT_EMAIL_TO || 'labs.ativaai@gmail.com'

  if (!apiKey || !from) {
    log.error({ hasApiKey: !!apiKey, hasFrom: !!from }, 'daily report: SENDGRID_API_KEY/REPORT_EMAIL_FROM não configurados — relatório NÃO enviado')
    return
  }

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: 'MailHub' },
      subject: `MailHub — Relatório de Triagem — ${dateKey}`,
      content: [{ type: 'text/plain', value: 'Relatório do dia em anexo.' }],
      attachments: [{
        content: Buffer.from(txt, 'utf-8').toString('base64'),
        filename: `mailhub-relatorio-${dateKey}.txt`,
        type: 'text/plain',
        disposition: 'attachment',
      }],
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`SendGrid respondeu ${res.status}: ${body.slice(0, 500)}`)
  }

  log.info({ dateKey, to }, 'daily report: email enviado')
}
