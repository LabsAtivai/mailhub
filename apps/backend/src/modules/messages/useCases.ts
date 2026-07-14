import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import { messageRepository as repo } from './repository'
import { redis } from '../../lib/redis'
import { scope } from '../../lib/logger'
import { decrypt } from '../../lib/crypto'
import { touchAccountActivity } from '../../lib/accountActivity'

const log = scope('messages')

export class ForbiddenError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}
export class SmtpError extends Error {
  constructor(message: string) { super(message); this.name = 'SmtpError' }
}

const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024 // 20MB, alinhado ao limite comum de provedores de e-mail

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

interface SearchFilters {
  fromEmail?: { contains: string; mode: string }
  toJson?: { contains: string; mode: string }
  subject?: { contains: string; mode: string }
  hasAttachments?: boolean
  isRead?: boolean
  isFlagged?: boolean
  OR?: Array<Record<string, unknown>>
}

export const messageUseCases = {
  async listFolder(folderId: string, userId: string, limit: number, cursor?: string) {
    const folder = await requireOwnedFolder(folderId, userId)
    await touchAccountActivity(folder.account.id)
    const rows = await repo.listByFolder(folderId, limit, cursor)
    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore
      ? `${items[items.length - 1].date.toISOString()}_${items[items.length - 1].id}`
      : null
    return { items: items.map(m => ({ ...m, labels: m.labels.map(ml => ml.label) })), nextCursor }
  },

  async getDetail(messageId: string, userId: string) {
    const msg = await requireOwnedMessage(messageId, userId)
    const labels = msg.labels.map(ml => ml.label)

    // Checa a flag \Answered/\Seen direto no IMAP ao abrir — a sincronização
    // periódica só revê flags dos últimos 90 dias, então uma resposta feita
    // por fora (ex: webmail anterior) em mensagem mais antiga só é percebida
    // aqui, na hora de abrir, evitando responder algo já respondido.
    await redis.publish('mailhub:flag:refresh', JSON.stringify({
      messageId: msg.id, accountId: msg.folder.account.id,
      folderId: msg.folderId, uid: msg.uid.toString(),
    }))

    if (!msg.bodyFetchedAt) {
      await redis.publish('mailhub:fetch:body', JSON.stringify({ messageId: msg.id }))
      return { ...msg, labels, bodyFetching: true }
    }
    return { ...msg, labels, bodyFetching: false }
  },

  async setFlags(messageId: string, userId: string, flags: { isRead?: boolean; isFlagged?: boolean }) {
    const msg = await requireOwnedMessage(messageId, userId)
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

    const filters: SearchFilters = {}
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

    const where: Record<string, unknown> = { ...filters }
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
    const rows = await repo.search(accountIds, where)
    return rows.map(m => ({ ...m, labels: m.labels.map(ml => ml.label) }))
  },

  async send(userId: string, dto: {
    accountId: string; to: string[]; cc?: string[]
    subject: string; html: string; text?: string; inReplyTo?: string
    attachments?: Array<{ filename: string; mimeType?: string; content: string }>
  }) {
    const account = await repo.findAccountForUser(dto.accountId, userId)
    if (!account) throw new NotFoundError('Conta não encontrada')
    await touchAccountActivity(account.id)

    const attachments = (dto.attachments ?? []).map(a => ({
      filename: a.filename,
      content: Buffer.from(a.content, 'base64'),
      contentType: a.mimeType,
    }))
    const totalBytes = attachments.reduce((sum, a) => sum + a.content.length, 0)
    if (totalBytes > MAX_ATTACHMENTS_BYTES) {
      throw new ValidationError('Anexos excedem o limite de 20MB')
    }

    const isSendGrid = account.outgoingHost === 'smtp.sendgrid.net'
    const smtpAuth = isSendGrid
      ? { user: 'apikey', pass: process.env.SENDGRID_API_KEY ?? '' }
      : { user: account.username, pass: decrypt(account.encryptedPassword) }
    const transporter = nodemailer.createTransport({
      host: account.outgoingHost,
      port: account.outgoingPort,
      secure: account.tlsMode === 'TLS',
      auth: smtpAuth,
    })

    const mailOptions = {
      from: `${account.displayName} <${account.emailAddress}>`,
      to: dto.to.join(', '),
      cc: dto.cc?.join(', '),
      subject: dto.subject,
      html: dto.html,
      text: dto.text || '',
      inReplyTo: dto.inReplyTo,
      references: dto.inReplyTo,
      attachments: attachments.length > 0 ? attachments : undefined,
    }

    let info
    try {
      info = await transporter.sendMail(mailOptions)
    } catch (err: unknown) {
      const e = err as Record<string, unknown>
      const code = e?.responseCode ?? e?.code ?? ''
      const msg = e?.response ?? e?.message ?? 'Falha no envio'
      log.error({ accountId: account.id, from: account.emailAddress, code, msg: String(msg) }, 'smtp send failed')
      throw new SmtpError(String(msg))
    } finally {
      transporter.close()
    }

    // O worker não tem os dados da mensagem (from/to/html/anexos) para montar o
    // RFC822 sozinho, então geramos o mesmo MIME que foi enviado e deixamos no
    // Redis por um curto período pra ele fazer o APPEND na pasta Sent via IMAP.
    // Sem isso, a mensagem enviada nunca aparecia em "Enviados" (o provedor
    // não copia automaticamente o que foi mandado por SMTP autenticado).
    try {
      const raw = await new MailComposer(mailOptions).compile().build()
      await redis.set(`mailhub:sentraw:${account.id}:${info.messageId}`, raw.toString('base64'), 'EX', 300)
    } catch (err: unknown) {
      log.warn({ accountId: account.id, err: err instanceof Error ? err.message : String(err) }, 'failed to build raw MIME for Sent append')
    }

    await redis.publish('mailhub:sent:append', JSON.stringify({
      accountId: account.id, messageId: info.messageId,
    }))

    if (dto.inReplyTo) {
      const original = await repo.findAndMarkAnswered(account.id, dto.inReplyTo)
      if (original) {
        await redis.publish('mailhub:flag:update', JSON.stringify({
          accountId: account.id, messageId: original.id,
          folderId: original.folderId, uid: original.uid.toString(), isAnswered: true,
        }))
      }
    }

    log.info({ accountId: account.id, to: dto.to.length }, 'message sent via smtp')
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
