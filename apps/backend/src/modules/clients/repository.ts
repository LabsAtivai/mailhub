import { prisma } from '../../lib/prisma'

export const clientRepository = {
  async listByAccount(accountId: string) {
    return prisma.clientProfile.findMany({
      where: { accountId },
      orderBy: { clientName: 'asc' },
    })
  },

  async findByDomain(accountId: string, domain: string) {
    return prisma.clientProfile.findUnique({
      where: { accountId_domain: { accountId, domain } },
    })
  },

  async findByIdForAccount(id: string, accountId: string) {
    return prisma.clientProfile.findFirst({ where: { id, accountId } })
  },

  async upsert(accountId: string, domain: string, clientName: string, content: string) {
    return prisma.clientProfile.upsert({
      where: { accountId_domain: { accountId, domain } },
      create: { accountId, domain, clientName, content },
      update: { clientName, content },
    })
  },

  async remove(id: string) {
    await prisma.clientProfile.delete({ where: { id } })
  },
}
