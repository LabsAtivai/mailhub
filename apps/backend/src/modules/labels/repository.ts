import { prisma } from '../../lib/prisma'

export const labelRepository = {
  async listForUser(userId: string) {
    return prisma.label.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { messages: true } } },
    })
  },

  async findByName(userId: string, name: string, excludeId?: string) {
    return prisma.label.findFirst({
      where: {
        userId,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    })
  },

  async findForUser(id: string, userId: string) {
    return prisma.label.findFirst({ where: { id, userId } })
  },

  async create(userId: string, name: string, color: string) {
    return prisma.label.create({ data: { userId, name, color } })
  },

  async update(id: string, data: { name?: string; color?: string }) {
    return prisma.label.update({ where: { id }, data })
  },

  async remove(id: string) {
    return prisma.label.delete({ where: { id } })
  },

  async messagesByLabel(labelId: string, limit: number, cursor?: string) {
    const where: any = { labels: { some: { labelId } } }
    if (cursor) {
      const [date, id] = cursor.split('_')
      where.OR = [{ date: { lt: new Date(date) } }, { date: new Date(date), id: { lt: id } }]
    }
    return prisma.message.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true, uid: true, subject: true, preview: true,
        fromName: true, fromEmail: true, toJson: true,
        date: true, isRead: true, isFlagged: true, hasAttachments: true, size: true,
      },
    })
  },
}
