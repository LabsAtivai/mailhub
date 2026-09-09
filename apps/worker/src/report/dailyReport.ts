import { prisma } from '../lib/prisma'
import { scope } from '../lib/logger'
import { fetchBody } from '../sync/syncAccount'
import { classifyReply, LeadStatus } from './classifier'
import { sendReportEmail } from './mailer'

const log = scope('report')

// "Interessados" e "Encaminhamentos" já existem como label padrão seedada por
// usuário (ver backend/src/modules/labels/repository.ts DEFAULT_LABELS) — usa
// o mesmo nome/cor aqui em vez de criar uma label quase-duplicada (singular
// vs plural) pro mesmo conceito. "Negado" e "Outro" não têm equivalente, são
// novas.
const LABEL_BY_STATUS: Record<LeadStatus, { name: string; color: string }> = {
  interessado: { name: 'Interessados', color: '#4CAF50' },
  encaminhamento: { name: 'Encaminhamentos', color: '#9C27B0' },
  negado: { name: 'Negado', color: '#D32F2F' },
  outro: { name: 'Outro', color: '#9E9E9E' },
}

const EMPTY_COUNTS = (): Record<LeadStatus, number> => ({ interessado: 0, encaminhamento: 0, negado: 0, outro: 0 })

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

async function ensureLabel(userId: string, status: LeadStatus) {
  const { name, color } = LABEL_BY_STATUS[status]
  const existing = await prisma.label.findFirst({
    where: { userId, name: { equals: name, mode: 'insensitive' } },
  })
  if (existing) return existing
  return prisma.label.create({ data: { userId, name, color } })
}

interface AccountReport {
  displayName: string
  emailAddress: string
  syncIssue: string | null
  counts: Record<LeadStatus, number>
  interested: Array<{ email: string; name: string | null; subject: string | null }>
}

export async function runDailyReport(dateKey: string): Promise<void> {
  log.info({ dateKey }, 'daily report: starting')

  const startOfDay = new Date(`${dateKey}T00:00:00-03:00`)
  const endOfDay = new Date(`${dateKey}T23:59:59.999-03:00`)

  const accounts = await prisma.mailAccount.findMany({
    select: { id: true, userId: true, displayName: true, emailAddress: true, syncState: true, lastError: true },
    orderBy: { emailAddress: 'asc' },
  })

  const reports: AccountReport[] = []

  for (const account of accounts) {
    // Inbox + Spam: resposta de lead às vezes cai no Spam (falso positivo do
    // provedor), e essas são justamente as que mais importa não perder.
    const scannedFolders = await prisma.folder.findMany({
      where: { accountId: account.id, specialUse: { in: ['\\Inbox', '\\Junk'] } },
      select: { id: true },
    })

    const counts = EMPTY_COUNTS()
    const interested: AccountReport['interested'] = []

    if (scannedFolders.length > 0) {
      const messages = await prisma.message.findMany({
        where: { folderId: { in: scannedFolders.map(f => f.id) }, date: { gte: startOfDay, lte: endOfDay } },
        select: {
          id: true, subject: true, textBody: true, htmlBody: true, bodyFetchedAt: true,
          fromEmail: true, fromName: true, leadStatus: true,
        },
      })

      for (const msg of messages) {
        // Tag "(WRM)" no assunto = warmup automático de deliverability, não é
        // resposta de lead. Nem entra na contagem nem é classificado. Assunto
        // real usa parênteses — bracket cobre variante que nunca apareceu.
        if (/\(WRM\)|\[WRM\]/i.test(msg.subject || '')) continue

        let status = msg.leadStatus as LeadStatus | null

        // Idempotente: mensagem já classificada numa rodada anterior do mesmo
        // dia (ex: worker reiniciou) não é reclassificada nem paga IA de novo.
        if (!status) {
          try {
            if (!msg.bodyFetchedAt) await fetchBody(msg.id)
            const fresh = await prisma.message.findUnique({
              where: { id: msg.id },
              select: { textBody: true, htmlBody: true },
            })
            const body = fresh?.textBody || (fresh?.htmlBody ? stripHtml(fresh.htmlBody) : '')
            status = await classifyReply(msg.subject || '', body)
          } catch (err) {
            log.error({ messageId: msg.id, err: err instanceof Error ? err.message : String(err) }, 'daily report: falha ao classificar, marcando como outro')
            status = 'outro'
          }

          await prisma.message.update({
            where: { id: msg.id },
            data: { leadStatus: status, classifiedAt: new Date() },
          })

          const label = await ensureLabel(account.userId, status)
          await prisma.messageLabel.upsert({
            where: { messageId_labelId: { messageId: msg.id, labelId: label.id } },
            update: {},
            create: { messageId: msg.id, labelId: label.id },
          })
        }

        counts[status]++
        if (status === 'interessado') {
          interested.push({ email: msg.fromEmail || '(sem remetente)', name: msg.fromName, subject: msg.subject })
        }
      }
    }

    reports.push({
      displayName: account.displayName,
      emailAddress: account.emailAddress,
      syncIssue: account.syncState === 'ERROR' ? (account.lastError || 'erro de sincronização') : null,
      counts,
      interested,
    })
  }

  const txt = buildReportText(dateKey, reports)
  await sendReportEmail(dateKey, txt)
  log.info({ dateKey, accounts: reports.length }, 'daily report: finished')
}

function buildReportText(dateKey: string, reports: AccountReport[]): string {
  const lines: string[] = []
  lines.push(`MailHub — Relatório de Triagem — ${dateKey}`)
  lines.push('')

  const totals = EMPTY_COUNTS()
  const problems: AccountReport[] = []

  for (const r of reports) {
    lines.push(`=== ${r.emailAddress} (${r.displayName}) ===`)
    lines.push(`Interessados: ${r.counts.interessado}`)
    for (const i of r.interested) {
      lines.push(`  - ${i.email}${i.name ? ` (${i.name})` : ''} — "${i.subject || '(sem assunto)'}"`)
    }
    lines.push(`Encaminhamentos: ${r.counts.encaminhamento}`)
    lines.push(`Negados: ${r.counts.negado}`)
    lines.push(`Outros: ${r.counts.outro}`)
    lines.push('')

    ;(Object.keys(totals) as LeadStatus[]).forEach(k => { totals[k] += r.counts[k] })
    if (r.syncIssue) problems.push(r)
  }

  if (problems.length > 0) {
    lines.push('--- Contas com problema de sincronização (dados podem estar incompletos) ---')
    for (const p of problems) lines.push(`${p.emailAddress} — último erro: "${p.syncIssue}"`)
    lines.push('')
  }

  lines.push(`TOTAIS GERAIS: Interessados ${totals.interessado} | Encaminhamentos ${totals.encaminhamento} | Negados ${totals.negado} | Outros ${totals.outro}`)
  return lines.join('\n')
}
