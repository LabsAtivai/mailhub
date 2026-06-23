import 'dotenv/config'
import { z } from 'zod'
import { redis } from './lib/redis'
import { pool } from './lib/imapPool'
import { syncAccount, fetchBody, ensureIdle, getOpsClient } from './sync/syncAccount'
import { prisma } from './lib/prisma'
import { logger } from './lib/logger'

logger.info('starting mailhub-worker')
if (process.env.IMAP_PROXY_URL) logger.info({ proxy: process.env.IMAP_PROXY_URL }, 'IMAP proxy configured')

const sub = redis.duplicate()

sub.subscribe(
  'mailhub:sync:start',
  'mailhub:fetch:body',
  'mailhub:flag:update',
  'mailhub:message:move',
  'mailhub:message:delete',
  'mailhub:sent:append',
  'mailhub:fetch:attachment',
  (err) => { if (err) logger.error({ err }, 'redis subscribe error') }
)

const SyncStartSchema = z.object({ accountId: z.string() })
const FetchBodySchema = z.object({ messageId: z.string() })
const FlagUpdateSchema = z.object({
  accountId: z.string(), uid: z.string(), messageId: z.string(),
  isRead: z.boolean().optional(), isFlagged: z.boolean().optional(),
})
const MoveSchema = z.object({
  accountId: z.string(), uid: z.string(), messageId: z.string(),
  sourceFolderId: z.string(), targetFolderId: z.string(),
})
const DeleteSchema = z.object({
  accountId: z.string(), uid: z.string(), messageId: z.string(),
  folderId: z.string(), trashFolderId: z.string().nullable().optional(),
})
const SentAppendSchema = z.object({ accountId: z.string(), messageId: z.string().optional() })
const FetchAttachmentSchema = z.object({
  attachmentId: z.string(), messageId: z.string(), accountId: z.string(),
  folderPath: z.string(), uid: z.string(), filename: z.string(),
  contentId: z.string().nullable().optional(),
})

sub.on('message', async (channel: string, message: string) => {
  try {
    const raw = JSON.parse(message)
    switch (channel) {
      case 'mailhub:sync:start': {
        const p = SyncStartSchema.parse(raw)
        await syncAccount(p.accountId)
        break
      }
      case 'mailhub:fetch:body': {
        const p = FetchBodySchema.parse(raw)
        await fetchBody(p.messageId)
        break
      }
      case 'mailhub:flag:update': {
        const p = FlagUpdateSchema.parse(raw)
        await handleFlagUpdate(p)
        break
      }
      case 'mailhub:message:move': {
        const p = MoveSchema.parse(raw)
        await handleMove(p)
        break
      }
      case 'mailhub:message:delete': {
        const p = DeleteSchema.parse(raw)
        await handleDelete(p)
        break
      }
      case 'mailhub:sent:append': {
        const p = SentAppendSchema.parse(raw)
        await handleSentAppend(p)
        break
      }
      case 'mailhub:fetch:attachment': {
        const p = FetchAttachmentSchema.parse(raw)
        await handleFetchAttachment(p)
        break
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error({ channel, err: errMsg }, 'command handler error')
  }
})

interface FlagPayload { accountId: string; uid: string; messageId: string; isRead?: boolean; isFlagged?: boolean }

async function handleFlagUpdate(payload: FlagPayload) {
  const { accountId, uid, isRead, isFlagged, messageId } = payload
  const msg = await prisma.message.findUnique({ where: { id: messageId }, include: { folder: true } })
  if (!msg) return

  const client = await getOpsClient(accountId)
  const lock = await client.getMailboxLock(msg.folder.path)
  try {
    if (typeof isRead === 'boolean') {
      if (isRead) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
      else await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true })
    }
    if (typeof isFlagged === 'boolean') {
      if (isFlagged) await client.messageFlagsAdd(uid, ['\\Flagged'], { uid: true })
      else await client.messageFlagsRemove(uid, ['\\Flagged'], { uid: true })
    }
  } finally {
    lock.release()
  }

  const update: Record<string, unknown> = { accountId, messageId }
  if (typeof isRead === 'boolean') update.isRead = isRead
  if (typeof isFlagged === 'boolean') update.isFlagged = isFlagged
  await redis.publish('mail:updated', JSON.stringify(update))
}

interface MovePayload { accountId: string; uid: string; messageId: string; sourceFolderId: string; targetFolderId: string }

async function handleMove(payload: MovePayload) {
  const { accountId, uid, sourceFolderId, targetFolderId, messageId } = payload
  const [source, target] = await Promise.all([
    prisma.folder.findUnique({ where: { id: sourceFolderId } }),
    prisma.folder.findUnique({ where: { id: targetFolderId } }),
  ])
  if (!source || !target) return

  const client = await getOpsClient(accountId)
  const lock = await client.getMailboxLock(source.path)
  try {
    await client.messageMove(uid, target.path, { uid: true })
  } finally {
    lock.release()
  }

  await prisma.message.delete({ where: { id: messageId } }).catch(() => {})
  await redis.publish('mail:deleted', JSON.stringify({ accountId, messageId, folderId: sourceFolderId }))
}

interface DeletePayload { accountId: string; uid: string; messageId: string; folderId: string; trashFolderId?: string | null }

async function handleDelete(payload: DeletePayload) {
  const { accountId, uid, folderId, trashFolderId, messageId } = payload
  const source = await prisma.folder.findUnique({ where: { id: folderId } })
  if (!source) return

  const client = await getOpsClient(accountId)
  const lock = await client.getMailboxLock(source.path)
  try {
    if (trashFolderId) {
      const trash = await prisma.folder.findUnique({ where: { id: trashFolderId } })
      if (trash) await client.messageMove(uid, trash.path, { uid: true })
    } else {
      await client.messageDelete(uid, { uid: true })
    }
  } finally {
    lock.release()
  }

  await prisma.message.delete({ where: { id: messageId } }).catch(() => {})
  await redis.publish('mail:deleted', JSON.stringify({ accountId, messageId, folderId }))
}

// ── sent append: copy sent message to IMAP Sent folder ──────────────────────
async function handleSentAppend(payload: { accountId: string; messageId?: string }) {
  const { accountId } = payload
  const sentFolder = await prisma.folder.findFirst({
    where: { accountId, OR: [{ specialUse: '\\Sent' }, { path: 'Sent' }, { path: 'INBOX.Sent' }] },
  })
  if (!sentFolder) {
    logger.warn({ accountId }, 'no Sent folder found, skipping append')
    return
  }
  await syncAccount(accountId)
}

// ── fetch attachment: download attachment content from IMAP ──────────────────
interface AttachmentPayload {
  attachmentId: string; messageId: string; accountId: string
  folderPath: string; uid: string; filename: string; contentId?: string | null
}

async function handleFetchAttachment(payload: AttachmentPayload) {
  const { accountId, folderPath, uid, attachmentId } = payload
  const client = await getOpsClient(accountId)
  const lock = await client.getMailboxLock(folderPath)
  try {
    const rawMsg = await client.fetchOne(uid, { source: true }, { uid: true })
    const source = rawMsg ? (rawMsg as unknown as Record<string, unknown>).source : undefined
    if (!source) {
      logger.warn({ attachmentId, uid }, 'message source not found for attachment')
      return
    }
    const { simpleParser } = await import('mailparser')
    const parsed = await simpleParser(source as Buffer)
    const att = (parsed.attachments || []).find(
      a => a.filename === payload.filename || a.cid === payload.contentId
    )
    if (!att) {
      logger.warn({ attachmentId, filename: payload.filename }, 'attachment not found in message')
      return
    }
    logger.info({ attachmentId, size: att.size }, 'attachment fetched')
  } finally {
    lock.release()
  }
}

// ── concurrency-limited sync runner ─────────────────────────────────────────
async function runWithConcurrency(
  ids: string[],
  concurrency: number,
  label: string,
): Promise<void> {
  const queue = [...ids]
  const results: Array<{ id: string; error?: string }> = []
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const id = queue.shift()!
      try {
        await syncAccount(id)
        results.push({ id })
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        logger.error({ accountId: id, err: errMsg }, `${label} sync failed`)
        results.push({ id, error: errMsg })
      }
    }
  })
  await Promise.allSettled(workers)
  const failed = results.filter(r => r.error)
  if (failed.length > 0) {
    logger.warn({ failedCount: failed.length, total: ids.length }, `${label} sync completed with errors`)
  }
}

// ── periodic incremental sync every 2 minutes ───────────────────────────────
setInterval(async () => {
  try {
    const accounts = await prisma.mailAccount.findMany({
      where: { syncEnabled: true, syncState: { not: 'SYNCING' } },
      select: { id: true }
    })
    await runWithConcurrency(accounts.map(a => a.id), 10, 'periodic')
  } catch (err) {
    const errMsg = err instanceof Error ? (err as Error).message : String(err)
    logger.error({ err: errMsg }, 'periodic sync scheduler error')
  }
}, 2 * 60 * 1000)

// ── boot: reset stale SYNCING states + sync all accounts ────────────────────
prisma.mailAccount.updateMany({
  where: { syncState: 'SYNCING' },
  data: { syncState: 'IDLE' },
}).then(({ count }) => {
  if (count > 0) logger.info({ count }, 'reset stale SYNCING accounts')
  return prisma.mailAccount.findMany({ where: { syncEnabled: true }, select: { id: true } })
}).then(accounts => {
  logger.info({ count: accounts.length }, 'accounts to sync on boot')
  runWithConcurrency(accounts.map(a => a.id), 10, 'boot')
    .then(() => logger.info('boot sync finished'))
    .catch(err => logger.error({ err: err instanceof Error ? err.message : String(err) }, 'boot sync crashed'))
})

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down worker')
  sub.unsubscribe()
  await sub.quit().catch(() => {})
  await redis.quit().catch(() => {})
  await pool.disconnectAll()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
