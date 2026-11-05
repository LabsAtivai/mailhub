import { prisma } from '../../lib/prisma'

// Lista de não contatar por cliente. clientKey = caixa dona do conteúdo
// (knowledgeAccountId ?? accountId), então vale para todas as caixas do cliente.

export async function isSuppressed(clientKey: string, email: string): Promise<boolean> {
  const row = await prisma.autoReplySuppression.findUnique({
    where: { clientKey_email: { clientKey, email: email.toLowerCase() } },
    select: { id: true },
  })
  return !!row
}

export async function suppress(clientKey: string, email: string, reason: string): Promise<void> {
  const e = email.toLowerCase()
  await prisma.autoReplySuppression.upsert({
    where: { clientKey_email: { clientKey, email: e } },
    create: { clientKey, email: e, reason },
    update: {},
  })
}
