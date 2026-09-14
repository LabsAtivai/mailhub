import { prisma } from '../lib/prisma'
import { scope } from '../lib/logger'
import { fetchBody } from '../sync/syncAccount'
import { classifyReply, summarizeInterestedLead, LeadStatus } from './classifier'
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

export interface AccountReport {
  displayName: string
  emailAddress: string
  syncIssue: string | null
  counts: Record<LeadStatus, number>
  interested: Array<{ email: string; name: string | null; subject: string | null; company: string; note: string }>
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
        let bodyText: string | null = null
        const resolveBody = async (): Promise<string> => {
          if (bodyText !== null) return bodyText
          if (!msg.bodyFetchedAt) await fetchBody(msg.id)
          const fresh = await prisma.message.findUnique({
            where: { id: msg.id },
            select: { textBody: true, htmlBody: true },
          })
          bodyText = fresh?.textBody || (fresh?.htmlBody ? stripHtml(fresh.htmlBody) : '')
          return bodyText
        }

        // Idempotente: mensagem já classificada numa rodada anterior do mesmo
        // dia (ex: worker reiniciou) não é reclassificada nem paga IA de novo.
        if (!status) {
          try {
            status = await classifyReply(msg.subject || '', await resolveBody())
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
          // Resumo (company/note) é só pro corpo do relatório — recalculado a
          // cada execução (não persistido), custo baixo pq só roda pros
          // classificados como interessado, não pra caixa inteira.
          const { company, note } = await summarizeInterestedLead({
            fromName: msg.fromName,
            fromEmail: msg.fromEmail || '',
            subject: msg.subject || '',
            body: await resolveBody(),
          })
          interested.push({ email: msg.fromEmail || '(sem remetente)', name: msg.fromName, subject: msg.subject, company, note })
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

function formatDateShort(dateKey: string): string {
  const [, month, day] = dateKey.split('-')
  return `${day}/${month}`
}

function leadLine(i: AccountReport['interested'][number]): string {
  const person = i.name || i.email
  const companyPart = i.company ? ` (${i.company})` : ''
  return `${person}${companyPart} — ${i.note}.`
}

export function buildReportText(dateKey: string, reports: AccountReport[]): string {
  const lines: string[] = []

  const totals = EMPTY_COUNTS()
  const problems: AccountReport[] = []
  for (const r of reports) {
    ;(Object.keys(totals) as LeadStatus[]).forEach(k => { totals[k] += r.counts[k] })
    if (r.syncIssue) problems.push(r)
  }

  lines.push(`📌 *Resumo — Interessados e Encaminhamentos | ${formatDateShort(dateKey)}*`)
  lines.push('')

  lines.push(`🔥 *INTERESSADOS — ${totals.interessado}*`)
  lines.push('')
  for (const r of reports) {
    if (r.interested.length === 0) continue
    if (r.interested.length === 1) {
      lines.push(`• *${r.displayName}:* ${leadLine(r.interested[0])}`)
    } else {
      lines.push(`• *${r.displayName}:*`)
      for (const i of r.interested) lines.push(`   - ${leadLine(i)}`)
    }
  }
  lines.push('')

  lines.push(`📤 *ENCAMINHAMENTOS — ${totals.encaminhamento}*`)
  lines.push('')
  for (const r of reports) {
    if (r.counts.encaminhamento === 0) continue
    lines.push(`• *${r.displayName}:* ${r.counts.encaminhamento} encaminhamento${r.counts.encaminhamento > 1 ? 's' : ''}`)
  }

  if (problems.length > 0) {
    lines.push('')
    lines.push('⚠️ *Contas com problema de sincronização (dados podem estar incompletos)*')
    for (const p of problems) lines.push(`• ${p.emailAddress} — último erro: "${p.syncIssue}"`)
  }

  return lines.join('\n')
}
