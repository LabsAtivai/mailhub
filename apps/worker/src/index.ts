import 'dotenv/config'
import { redis } from './lib/redis'
import { pool } from './lib/imapPool'
import { syncAccount, fetchBody, ensureIdle, getOpsClient } from './sync/syncAccount'
import { prisma } from './lib/prisma'
import { logger } from './lib/logger'

logger.info('starting mailhub-worker')

const sub = redis.duplicate()

sub.subscribe(
  'mailhub:sync:start',
  'mailhub:fetch:body',
  'mailhub:flag:update',
  'mailhub:message:move',
  'mailhub:message:delete',
  (err) => { if (err) logger.error({ err }, 'redis subscribe error') }
)

sub.on('message', async (channel: string, message: string) => {
  try {
    const payload = JSON.parse(message)
    switch (channel) {
      case 'mailhub:sync:start':   await syncAccount(payload.accountId); break
      case 'mailhub:fetch:body':   await fetchBody(payload.messageId); break
      case 'mailhub:flag:update':  await handleFlagUpdate(payload); break
      case 'mailhub:message:move': await handleMove(payload); break
      case 'mailhub:message:delete': await handleDelete(payload); break
    }
  } catch (err: any) {
    logger.error({ channel, err: err.message }, 'command handler error')
  }
})

async function handleFlagUpdate(payload: any) {
  const { accountId, uid, isRead, isFlagged, messageId } = payload
  const msg = await prisma.message.findUnique({ where: { id: messageId }, include: { folder: true } })
  if (!msg) return

  const client = await getOpsClient(accountId)
  const lock = await client.getMailboxLock(msg.folder.path)
  try {
    const uidStr = String(uid)
    if (typeof isRead === 'boolean') {
      if (isRead) await client.messageFlagsAdd(uidStr, ['\\Seen'], { uid: true })
      else await client.messageFlagsRemove(uidStr, ['\\Seen'], { uid: true })
    }
    if (typeof isFlagged === 'boolean') {
      if (isFlagged) await client.messageFlagsAdd(uidStr, ['\\Flagged'], { uid: true })
      else await client.messageFlagsRemove(uidStr, ['\\Flagged'], { uid: true })
    }
  } finally {
    lock.release()
  }

  const update: any = { accountId, messageId }
  if (typeof isRead === 'boolean') update.isRead = isRead
  if (typeof isFlagged === 'boolean') update.isFlagged = isFlagged
  await redis.publish('mail:updated', JSON.stringify(update))
}

async function handleMove(payload: any) {
  const { accountId, uid, sourceFolderId, targetFolderId, messageId } = payload
  const [source, target] = await Promise.all([
    prisma.folder.findUnique({ where: { id: sourceFolderId } }),
    prisma.folder.findUnique({ where: { id: targetFolderId } }),
  ])
  if (!source || !target) return

  const client = await getOpsClient(accountId)
  const lock = await client.getMailboxLock(source.path)
  try {
    await client.messageMove(String(uid), target.path, { uid: true })
  } finally {
    lock.release()
  }

  // UID changes when a message moves folders — remove the stale row;
  // the next incremental sync of the target folder re-imports it.
  await prisma.message.delete({ where: { id: messageId } }).catch(() => {})
  await redis.publish('mail:deleted', JSON.stringify({ accountId, messageId, folderId: sourceFolderId }))
}

async function handleDelete(payload: any) {
  const { accountId, uid, folderId, trashFolderId, messageId } = payload
  const source = await prisma.folder.findUnique({ where: { id: folderId } })
  if (!source) return

  const client = await getOpsClient(accountId)
  const lock = await client.getMailboxLock(source.path)
  try {
    if (trashFolderId) {
      const trash = await prisma.folder.findUnique({ where: { id: trashFolderId } })
      if (trash) await client.messageMove(String(uid), trash.path, { uid: true })
    } else {
      await client.messageDelete(String(uid), { uid: true })
    }
  } finally {
    lock.release()
  }

  await prisma.message.delete({ where: { id: messageId } }).catch(() => {})
  await redis.publish('mail:deleted', JSON.stringify({ accountId, messageId, folderId }))
}

// ── concurrency-limited sync runner ─────────────────────────────────────────
async function runWithConcurrency(
  ids: string[],
  concurrency: number,
  label: string,
): Promise<void> {
  const queue = [...ids]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const id = queue.shift()!
      await syncAccount(id).catch(e =>
        logger.error({ accountId: id, err: e.message }, `${label} sync failed`))
    }
  })
  await Promise.all(workers)
}

// ── periodic incremental sync every 2 minutes ───────────────────────────────
setInterval(async () => {
  const accounts = await prisma.mailAccount.findMany({
    where: { syncEnabled: true, syncState: { not: 'SYNCING' } },
    select: { id: true }
  })
  runWithConcurrency(accounts.map(a => a.id), 10, 'periodic').catch(() => {})
}, 2 * 60 * 1000)

// ── boot: sync all accounts + start IDLE watchers ───────────────────────────
prisma.mailAccount.findMany({ where: { syncEnabled: true }, select: { id: true } }).then(accounts => {
  logger.info({ count: accounts.length }, 'accounts to sync on boot')
  runWithConcurrency(accounts.map(a => a.id), 10, 'boot')
    .then(() => logger.info('boot sync finished'))
    .catch(err => logger.error({ err: err.message }, 'boot sync crashed'))
})

process.on('SIGTERM', async () => {
  await pool.disconnectAll()
  process.exit(0)
})
process.on('SIGINT', async () => {
  await pool.disconnectAll()
  process.exit(0)
})
