import { prisma } from '../../lib/prisma'
import { checkReadiness } from './readiness'

// Visão consolidada das caixas para o onboarding do agente: dados de infraestrutura,
// configuração, base de conhecimento e histórico num só retorno, sem expor credenciais.

const MAILCOW_HOST = 'mail.labsativa.com.br'
const MAX_ACCOUNTS = 100

export interface OverviewFilter {
  emails?: string[]   // endereços exatos
  domain?: string     // sufixo do endereço, ex: "avell.com.br"
  withAgent?: boolean // só caixas com AutoReplyConfig
  readiness?: boolean // inclui a verificação de prontidão completa
}

export async function getAutoReplyOverview(filter: OverviewFilter) {
  const emails = (filter.emails ?? []).map(e => e.trim().toLowerCase()).filter(Boolean)
  const domain = filter.domain?.trim().toLowerCase().replace(/^@/, '')

  const accounts = await prisma.mailAccount.findMany({
    where: {
      ...(emails.length ? { emailAddress: { in: emails, mode: 'insensitive' as const } } : {}),
      ...(domain ? { emailAddress: { endsWith: `@${domain}`, mode: 'insensitive' as const } } : {}),
      ...(filter.withAgent ? { autoReplyConfig: { isNot: null } } : {}),
    },
    orderBy: { emailAddress: 'asc' },
    take: MAX_ACCOUNTS + 1,
    select: {
      id: true, emailAddress: true, displayName: true, incomingHost: true, incomingPort: true,
      syncEnabled: true, syncState: true, lastSyncAt: true, lastError: true, authFailureCount: true,
      user: { select: { email: true } },
      autoReplyConfig: { select: { mode: true, clientName: true, signature: true, dailyLimit: true, testRecipient: true } },
      clientAssets: { select: { kind: true, filename: true, size: true, driveFileId: true } },
    },
  })
  const truncated = accounts.length > MAX_ACCOUNTS
  const page = accounts.slice(0, MAX_ACCOUNTS)
  const ids = page.map(a => a.id)

  const [logs, chunkRows] = await Promise.all([
    prisma.autoReplyLog.groupBy({ by: ['accountId', 'status'], where: { accountId: { in: ids } }, _count: { _all: true } }),
    ids.length
      ? prisma.$queryRaw<Array<{ accountId: string; chunks: bigint; sources: bigint }>>`
          SELECT "accountId", count(*) AS chunks, count(DISTINCT source) AS sources
          FROM "ClientKnowledgeChunk" WHERE "accountId" = ANY(${ids}::text[]) GROUP BY "accountId"`.catch(() => [])
      : Promise.resolve([]),
  ])

  const readiness = filter.readiness
    ? new Map(await Promise.all(page.map(async a => [a.id, await checkReadiness(a.id)] as const)))
    : null

  const items = page.map(a => {
    const k = chunkRows.find(r => r.accountId === a.id)
    const statusCounts: Record<string, number> = {}
    for (const l of logs) if (l.accountId === a.id) statusCounts[l.status] = l._count._all
    const r = readiness?.get(a.id)
    return {
      accountId: a.id,
      email: a.emailAddress,
      displayName: a.displayName,
      owner: a.user.email,
      mailServer: {
        host: a.incomingHost,
        port: a.incomingPort,
        platform: a.incomingHost.toLowerCase() === MAILCOW_HOST ? 'mailcow' : 'outro',
        syncEnabled: a.syncEnabled,
        syncState: a.syncState,
        lastSyncAt: a.lastSyncAt,
        lastError: a.lastError,
        authFailureCount: a.authFailureCount,
      },
      agent: a.autoReplyConfig && {
        mode: a.autoReplyConfig.mode,
        clientName: a.autoReplyConfig.clientName,
        hasSignature: !!a.autoReplyConfig.signature.trim(),
        dailyLimit: a.autoReplyConfig.dailyLimit,
        testRecipient: a.autoReplyConfig.testRecipient,
      },
      knowledge: { chunks: Number(k?.chunks ?? 0), sources: Number(k?.sources ?? 0) },
      assets: a.clientAssets,
      log: statusCounts,
      ...(r ? { readiness: { ok: r.ok, blockers: r.blockers.map(b => b.code), warnings: r.warnings.map(w => w.code) } } : {}),
    }
  })

  return { total: items.length, truncated, accounts: items }
}
