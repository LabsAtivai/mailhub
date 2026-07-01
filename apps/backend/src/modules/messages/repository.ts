import { prisma } from '../../lib/prisma'

export interface MessageListItem {
  id: string
  uid: bigint
  subject: string | null
  preview: string | null
  fromName: string | null
  fromEmail: string | null
  toJson: string
  date: Date
  isRead: boolean
  isFlagged: boolean
  hasAttachments: boolean
  size: number | null
  inReplyTo: string | null
  labels: { label: { id: string; name: string; color: string } }[]
}

const LIST_SELECT = {
  id: true, uid: true, subject: true, preview: true,
  fromName: true, fromEmail: true, toJson: true,
  date: true, isRead: true, isFlagged: true, hasAttachments: true, size: true,
  inReplyTo: true,
  labels: { select: { label: { select: { id: true, name: true, color: true } } } },
} as const

function parseCursor(cursor: string): { date: Date; id: string } {
  const sepIndex = cursor.indexOf('_')
  if (sepIndex === -1) throw new Error('Invalid cursor format')
  const dateStr = cursor.slice(0, sepIndex)
  const id = cursor.slice(sepIndex + 1)
  const date = new Date(dateStr)
  if (isNaN(date.getTime()) || !id) throw new Error('Invalid cursor format')
  return { date, id }
}

export const messageRepository = {
  // ownership-aware lookups
  async findFolderWithOwner(folderId: string) {
    return prisma.folder.findFirst({
      where: { id: folderId },
      include: { account: { select: { userId: true, id: true } } },
    })
  },

  async findMessageWithOwner(messageId: string) {
    return prisma.message.findFirst({
      where: { id: messageId },
      include: {
        folder: { include: { account: true } },
        attachments: true,
        labels: { include: { label: { select: { id: true, name: true, color: true } } } },
      },
    })
  },

  // listing
  async listByFolder(folderId: string, limit: number, cursor?: string) {
    const where: Record<string, unknown> = { folderId }
    if (cursor) {
      const { date, id } = parseCursor(cursor)
      where.OR = [{ date: { lt: date } }, { date, id: { lt: id } }]
    }
    return prisma.message.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: LIST_SELECT,
    })
  },

  async accountIdsForUser(userId: string) {
    const accounts = await prisma.mailAccount.findMany({ where: { userId }, select: { id: true } })
    return accounts.map(a => a.id)
  },

  async search(accountIds: string[], where: Record<string, unknown>, limit = 50) {
    return prisma.message.findMany({
      where: { accountId: { in: accountIds }, ...where },
      orderBy: { date: 'desc' },
      take: limit,
      select: LIST_SELECT,
    })
  },

  // mutations (DB side — IMAP side handled by worker via Redis)
  async setFlags(messageId: string, data: { isRead?: boolean; isFlagged?: boolean }) {
    return prisma.message.update({
      where: { id: messageId }, data,
      select: { id: true, isRead: true, isFlagged: true },
    })
  },

  async findTrashFolder(accountId: string) {
    return prisma.folder.findFirst({ where: { accountId, specialUse: '\\Trash' } })
  },

  // labels
  async assignLabel(messageId: string, labelId: string) {
    await prisma.messageLabel.upsert({
      where: { messageId_labelId: { messageId, labelId } },
      create: { messageId, labelId },
      update: {},
    })
    return this.labelsForMessage(messageId)
  },

  async removeLabel(messageId: string, labelId: string) {
    await prisma.messageLabel.deleteMany({ where: { messageId, labelId } })
    return this.labelsForMessage(messageId)
  },

  async labelsForMessage(messageId: string) {
    const rows = await prisma.messageLabel.findMany({
      where: { messageId },
      include: { label: { select: { id: true, name: true, color: true } } },
    })
    return rows.map(r => r.label)
  },

  async findLabelForUser(labelId: string, userId: string) {
    return prisma.label.findFirst({ where: { id: labelId, userId } })
  },

  async findAccountForUser(accountId: string, userId: string) {
    return prisma.mailAccount.findFirst({ where: { id: accountId, userId } })
  },

  async findAttachment(attachmentId: string) {
    return prisma.attachment.findUnique({ where: { id: attachmentId } })
  },
}
