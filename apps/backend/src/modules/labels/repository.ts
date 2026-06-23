import { prisma } from '../../lib/prisma'

const DEFAULT_LABELS = [
  { name: 'Interessados',     color: '#4CAF50' },
  { name: 'Apresentação',     color: '#2196F3' },
  { name: 'Vendido',          color: '#FF9800' },
  { name: 'Encaminhamentos',  color: '#9C27B0' },
  { name: 'Nutrição',         color: '#00BCD4' },
  { name: 'Perdido',          color: '#F44336' },
]

export const labelRepository = {
  async listForUser(userId: string) {
    return prisma.label.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { messages: true } } },
    })
  },

  async hasMissingDefaults(userId: string) {
    const existing = await prisma.label.findMany({
      where: { userId, name: { in: DEFAULT_LABELS.map(l => l.name) } },
      select: { name: true },
    })
    return existing.length < DEFAULT_LABELS.length
  },

  async seedDefaults(userId: string) {
    await prisma.label.createMany({
      data: DEFAULT_LABELS.map(l => ({ userId, name: l.name, color: l.color })),
      skipDuplicates: true,
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

  async messageCount(labelId: string) {
    return prisma.messageLabel.count({ where: { labelId } })
  },

  async remove(id: string) {
    return prisma.label.delete({ where: { id } })
  },

  async messagesByLabel(labelId: string, limit: number, cursor?: string) {
    const where: Record<string, unknown> = { labels: { some: { labelId } } }
    if (cursor) {
      const sepIndex = cursor.indexOf('_')
      if (sepIndex === -1) throw new Error('Invalid cursor format')
      const dateStr = cursor.slice(0, sepIndex)
      const id = cursor.slice(sepIndex + 1)
      const date = new Date(dateStr)
      if (isNaN(date.getTime()) || !id) throw new Error('Invalid cursor format')
      where.OR = [{ date: { lt: date } }, { date, id: { lt: id } }]
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
