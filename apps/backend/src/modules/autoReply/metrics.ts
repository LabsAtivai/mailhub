import { prisma } from '../../lib/prisma'

const SENT_STATUSES = ['sent', 'test_sent']
const LEAD_STATUSES = ['interessado', 'apresentacao', 'encaminhamento', 'negado', 'automatico', 'outro'] as const

export interface AutoReplyMetrics {
  mode: string
  days: number
  agent: {
    replies: number      // respostas enviadas pelo agente (live + teste)
    shadow: number       // rascunhos gerados sem envio
    skipped: number
    errors: number
    skippedByReason: Record<string, number>
  }
  interested: number     // leads respondidos pelo agente classificados como "interessado"
  replied: number        // leads respondidos pelo agente que escreveram de novo depois
  replyRate: number      // replied / replies (0 a 1)
  leadStatus: Record<string, number>  // métricas de triagem já existentes (INBOX do período)
  recent: Array<{ id: string; at: string; fromEmail: string; status: string; reason: string | null; draft: string | null }>
}

export async function getAutoReplyMetrics(accountId: string, days: number): Promise<AutoReplyMetrics> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const [cfg, grouped, skippedRows, interestedRows, repliedRows, leadRows, recent] = await Promise.all([
    prisma.autoReplyConfig.findUnique({ where: { accountId }, select: { mode: true } }),
    prisma.autoReplyLog.groupBy({
      by: ['status'], where: { accountId, createdAt: { gte: since } }, _count: { _all: true },
    }),
    prisma.autoReplyLog.groupBy({
      by: ['reason'], where: { accountId, createdAt: { gte: since }, status: 'skipped' }, _count: { _all: true },
    }),
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n
      FROM "AutoReplyLog" l
      JOIN "Message" m ON m.id = l."messageId"
      WHERE l."accountId" = ${accountId} AND l."createdAt" >= ${since}
        AND l.status IN ('sent', 'test_sent') AND m."leadStatus" = 'interessado'`,
    // "Respondeu": o mesmo remetente escreveu de novo na INBOX depois da resposta do agente.
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n
      FROM "AutoReplyLog" l
      WHERE l."accountId" = ${accountId} AND l."createdAt" >= ${since}
        AND l.status IN ('sent', 'test_sent')
        AND EXISTS (
          SELECT 1 FROM "Message" m
          JOIN "Folder" f ON f.id = m."folderId"
          WHERE m."accountId" = ${accountId} AND f."specialUse" = '\\Inbox'
            AND lower(m."fromEmail") = l."fromEmail"
            AND m.date > l."createdAt"
            AND m.id <> l."messageId")`,
    prisma.message.groupBy({
      by: ['leadStatus'],
      where: { accountId, date: { gte: since }, leadStatus: { not: null }, folder: { specialUse: '\\Inbox' } },
      _count: { _all: true },
    }),
    prisma.autoReplyLog.findMany({
      where: { accountId, status: { not: 'processing' } },
      orderBy: { createdAt: 'desc' }, take: 20,
      select: { id: true, createdAt: true, fromEmail: true, status: true, reason: true, draft: true },
    }),
  ])

  const count = (s: string) => grouped.find(g => g.status === s)?._count._all ?? 0
  const replies = SENT_STATUSES.reduce((acc, s) => acc + count(s), 0)
  const replied = Number(repliedRows[0]?.n ?? 0)

  const leadStatus: Record<string, number> = Object.fromEntries(LEAD_STATUSES.map(s => [s, 0]))
  for (const r of leadRows) if (r.leadStatus) leadStatus[r.leadStatus] = r._count._all

  return {
    mode: cfg?.mode ?? 'off',
    days,
    agent: {
      replies,
      shadow: count('shadow'),
      skipped: count('skipped'),
      errors: count('error'),
      skippedByReason: Object.fromEntries(skippedRows.map(r => [r.reason ?? 'outro', r._count._all])),
    },
    interested: Number(interestedRows[0]?.n ?? 0),
    replied,
    replyRate: replies ? replied / replies : 0,
    leadStatus,
    recent: recent.map(r => ({
      id: r.id, at: r.createdAt.toISOString(), fromEmail: r.fromEmail,
      status: r.status, reason: r.reason, draft: r.draft?.slice(0, 600) ?? null,
    })),
  }
}
