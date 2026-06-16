import nodemailer from 'nodemailer'
import { messageRepository as repo } from './repository'
import { decrypt } from '../../lib/crypto'
import { redis } from '../../lib/redis'
import { scope } from '../../lib/logger'

const log = scope('messages')

export class ForbiddenError extends Error {}
export class NotFoundError extends Error {}

// Verify the message belongs to the user; throws if not. Returns flattened message.
async function requireOwnedMessage(messageId: string, userId: string) {
  const msg = await repo.findMessageWithOwner(messageId)
  if (!msg || msg.folder.account.userId !== userId) throw new NotFoundError('Mensagem não encontrada')
  return msg
}

async function requireOwnedFolder(folderId: string, userId: string) {
  const folder = await repo.findFolderWithOwner(folderId)
  if (!folder || folder.account.userId !== userId) throw new NotFoundError('Pasta não encontrada')
  return folder
}

export const messageUseCases = {
  async listFolder(folderId: string, userId: string, limit: number, cursor?: string) {
    await requireOwnedFolder(folderId, userId)
    const rows = await repo.listByFolder(folderId, limit, cursor)
    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore
      ? `${items[items.length - 1].date.toISOString()}_${items[items.length - 1].id}`
      : null
    return { items, nextCursor }
  },

  async getDetail(messageId: string, userId: string) {
    const msg = await requireOwnedMessage(messageId, userId)
    const labels = msg.labels.map(ml => ml.label)

    if (!msg.bodyFetchedAt) {
      await redis.publish('mailhub:fetch:body', JSON.stringify({ messageId: msg.id }))
      return { ...msg, labels, bodyFetching: true }
    }
    return { ...msg, labels, bodyFetching: false }
  },

  async setFlags(messageId: string, userId: string, flags: { isRead?: boolean; isFlagged?: boolean }) {
    const msg = await requireOwnedMessage(messageId, userId)
    // IMAP first (via worker), then DB (AP-001)
    await redis.publish('mailhub:flag:update', JSON.stringify({
      messageId: msg.id, accountId: msg.folder.account.id,
      folderId: msg.folderId, uid: msg.uid.toString(), ...flags,
    }))
    return repo.setFlags(msg.id, flags)
  },

  async move(messageId: string, userId: string, targetFolderId: string) {
    const msg = await requireOwnedMessage(messageId, userId)
    await requireOwnedFolder(targetFolderId, userId)
    await redis.publish('mailhub:message:move', JSON.stringify({
      messageId: msg.id, accountId: msg.folder.account.id,
      sourceFolderId: msg.folderId, targetFolderId, uid: msg.uid.toString(),
    }))
  },

  async remove(messageId: string, userId: string) {
    const msg = await requireOwnedMessage(messageId, userId)
    const trash = await repo.findTrashFolder(msg.folder.account.id)
    await redis.publish('mailhub:message:delete', JSON.stringify({
      messageId: msg.id, accountId: msg.folder.account.id,
      folderId: msg.folderId, uid: msg.uid.toString(), trashFolderId: trash?.id,
    }))
  },

  async search(userId: string, rawQuery: string) {
    const q = rawQuery.trim()
    if (!q) return []

    const filters: any = {}
    let freeText = q

    const grab = (re: RegExp, apply: (m: RegExpMatchArray) => void) => {
      const m = q.match(re)
      if (m) { apply(m); freeText = freeText.replace(m[0], '').trim() }
    }
    grab(/from:(\S+)/, m => filters.fromEmail = { contains: m[1], mode: 'insensitive' })
    grab(/to:(\S+)/, m => filters.toJson = { contains: m[1], mode: 'insensitive' })
    grab(/subject:(\S+)/, m => filters.subject = { contains: m[1], mode: 'insensitive' })
    if (/has:attachment/.test(q)) { filters.hasAttachments = true; freeText = freeText.replace('has:attachment', '').trim() }
    if (/is:unread/.test(q)) { filters.isRead = false; freeText = freeText.replace('is:unread', '').trim() }
    if (/is:read/.test(q)) { filters.isRead = true; freeText = freeText.replace('is:read', '').trim() }
    if (/is:flagged/.test(q)) { filters.isFlagged = true; freeText = freeText.replace('is:flagged', '').trim() }

    const where: any = { ...filters }
    if (freeText) {
      where.OR = [
        { subject: { contains: freeText, mode: 'insensitive' } },
        { fromName: { contains: freeText, mode: 'insensitive' } },
        { fromEmail: { contains: freeText, mode: 'insensitive' } },
        { textBody: { contains: freeText, mode: 'insensitive' } },
        { preview: { contains: freeText, mode: 'insensitive' } },
      ]
    }

    const accountIds = await repo.accountIdsForUser(userId)
    return repo.search(accountIds, where)
  },

  async send(userId: string, dto: {
    accountId: string; to: string[]; cc?: string[]
    subject: string; html: string; text?: string; inReplyTo?: string
  }) {
    const account = await repo.findAccountForUser(dto.accountId, userId)
    if (!account) throw new NotFoundError('Conta não encontrada')

    const password = decrypt(account.encryptedPassword)
    const transporter = nodemailer.createTransport({
      host: account.outgoingHost,
      port: account.outgoingPort,
      secure: account.outgoingPort === 465,
      auth: { user: account.username, pass: password },
    })

    const info = await transporter.sendMail({
      from: `${account.displayName} <${account.emailAddress}>`,
      to: dto.to.join(', '),
      cc: dto.cc?.join(', '),
      subject: dto.subject,
      html: dto.html,
      text: dto.text || '',
      inReplyTo: dto.inReplyTo,
      references: dto.inReplyTo,
    })

    await redis.publish('mailhub:sent:append', JSON.stringify({
      accountId: account.id, messageId: info.messageId,
    }))
    log.info({ accountId: account.id, to: dto.to.length }, 'message sent')
    return { messageId: info.messageId }
  },

  // ── labels on messages ─────────────────────────────────────────────────────
  async assignLabel(messageId: string, userId: string, labelId: string) {
    const msg = await requireOwnedMessage(messageId, userId)
    const label = await repo.findLabelForUser(labelId, userId)
    if (!label) throw new NotFoundError('Etiqueta não encontrada')
    return repo.assignLabel(msg.id, labelId)
  },

  async removeLabel(messageId: string, userId: string, labelId: string) {
    const msg = await requireOwnedMessage(messageId, userId)
    const label = await repo.findLabelForUser(labelId, userId)
    if (!label) throw new NotFoundError('Etiqueta não encontrada')
    return repo.removeLabel(msg.id, labelId)
  },

  // ── attachments ────────────────────────────────────────────────────────────
  async requestAttachment(attachmentId: string, userId: string) {
    const attachment = await repo.findAttachment(attachmentId)
    if (!attachment) throw new NotFoundError('Anexo não encontrado')
    const msg = await requireOwnedMessage(attachment.messageId, userId)

    if (!msg.bodyFetchedAt) {
      await redis.publish('mailhub:fetch:body', JSON.stringify({ messageId: msg.id }))
    }
    await redis.publish('mailhub:fetch:attachment', JSON.stringify({
      attachmentId: attachment.id, messageId: msg.id,
      accountId: msg.folder.account.id, folderPath: msg.folder.path,
      uid: msg.uid.toString(), filename: attachment.filename, contentId: attachment.contentId,
    }))
    return {
      id: attachment.id, filename: attachment.filename,
      mimeType: attachment.mimeType, size: attachment.size, downloadPending: true,
    }
  },
}
