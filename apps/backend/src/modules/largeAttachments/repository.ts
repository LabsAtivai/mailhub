import { prisma } from '../../lib/prisma'

export const largeAttachmentRepository = {
  async create(data: {
    userId: string
    token: string
    originalFilename: string
    mimeType: string
    size: number
    storageKey: string
    expiresAt: Date
  }) {
    return prisma.largeAttachment.create({ data })
  },

  async findByToken(token: string) {
    return prisma.largeAttachment.findUnique({ where: { token } })
  },

  async incrementDownloadCount(id: string) {
    await prisma.largeAttachment.update({ where: { id }, data: { downloadCount: { increment: 1 } } })
  },

  async findExpired(now: Date) {
    return prisma.largeAttachment.findMany({ where: { expiresAt: { lt: now } } })
  },

  async remove(id: string) {
    await prisma.largeAttachment.delete({ where: { id } })
  },
}
