import { prisma } from './prisma'
import { redis } from './redis'

// Contas sem atividade recente ficam sem IDLE permanente (worker.ts só chama
// ensureIdle se lastActiveAt estiver dentro dessa janela) — é a mitigação pro
// estouro de conexões IMAP simultâneas contra o host compartilhado da
// HostGator (ver memória do projeto: "worker_cpanel_inodes"). Ao voltar a
// ficar ativa, republicamos mailhub:sync:start pra reabrir o IDLE sem
// depender do próximo ciclo de sync periódico (30min).
export const ACCOUNT_ACTIVE_THRESHOLD_MS = 60 * 60 * 1000 // 1h

export async function touchAccountActivity(accountId: string): Promise<void> {
  const account = await prisma.mailAccount.findUnique({
    where: { id: accountId },
    select: { lastActiveAt: true },
  })
  const wasInactive = !account?.lastActiveAt
    || (Date.now() - account.lastActiveAt.getTime()) > ACCOUNT_ACTIVE_THRESHOLD_MS

  await prisma.mailAccount.update({
    where: { id: accountId },
    data: { lastActiveAt: new Date() },
  })

  if (wasInactive) {
    await redis.publish('mailhub:sync:start', JSON.stringify({ accountId }))
  }
}
