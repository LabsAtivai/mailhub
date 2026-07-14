import { prisma } from './prisma'
import { redis } from './redis'

// Contas sem atividade recente ficam sem IDLE permanente (worker.ts só chama
// ensureIdle se lastActiveAt estiver dentro dessa janela) — é a mitigação pro
// estouro de conexões IMAP simultâneas contra o host compartilhado da
// HostGator (ver memória do projeto: "worker_cpanel_inodes"). Ao voltar a
// ficar ativa, republicamos mailhub:sync:start pra reabrir o IDLE sem
// depender do próximo ciclo de sync periódico (30min).
export const ACCOUNT_ACTIVE_THRESHOLD_MS = 60 * 60 * 1000 // 1h

export async function touchAccountActivity(
  accountId: string,
  opts: { triggerResync?: boolean } = {},
): Promise<void> {
  const { triggerResync = true } = opts
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

  // triggerResync: false é pra quem já sabe que um resync vai rolar por outro
  // caminho logo em seguida (ex: send() -> mailhub:sent:append -> syncAccount).
  // Publicar os dois juntos faz o worker rodar dois syncAccount() concorrentes
  // pra mesma conta; como syncAccount() só deixa UM rodar por vez (guarda de
  // syncState), o segundo vira no-op — podendo ser justo o que pegaria a
  // mensagem recém-enviada na pasta Sent.
  if (wasInactive && triggerResync) {
    await redis.publish('mailhub:sync:start', JSON.stringify({ accountId }))
  }
}
