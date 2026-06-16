import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { prisma } from '../lib/prisma'
import { decrypt } from '../lib/crypto'
import { redis } from '../lib/redis'
import { pool } from '../lib/imapPool'
import { scope }  from '../lib/logger'

const log = scope('sync')

const SYNC_DAYS = 90
const BATCH_SIZE = 200 // fetch envelope UIDs in chunks

function imapOptions(account: any) {
  return {
    host: account.incomingHost,
    port: account.incomingPort,
    secure: account.tlsMode === 'TLS',
    auth: { user: account.username, pass: decrypt(account.encryptedPassword) },
  }
}

export async function getOpsClient(accountId: string): Promise<ImapFlow> {
  const account = await prisma.mailAccount.findUnique({ where: { id: accountId } })
  if (!account) throw new Error('Account not found')
  const existing = pool.get(accountId, 'ops')
  if (existing) return existing
  return pool.connect(accountId, 'ops', imapOptions(account))
}

// ── Full / incremental sync ──────────────────────────────────────────────────
export async function syncAccount(accountId: string): Promise<void> {
  const account = await prisma.mailAccount.findUnique({ where: { id: accountId } })
  if (!account || !account.syncEnabled) return
  if (account.syncState === 'SYNCING') return

  await prisma.mailAccount.update({ where: { id: accountId }, data: { syncState: 'SYNCING' } })
  await redis.publish('account:syncState', JSON.stringify({ accountId, state: 'SYNCING', progress: 0 }))

  try {
    const client = await getOpsClient(accountId)
    const imapFolders = await client.list()
    const selectableFolders = imapFolders.filter(
      f => !(f.flags as Set<string> | undefined)?.has('\\Noselect')
    )
    const total = selectableFolders.length
    let done = 0
    const since = new Date(Date.now() - SYNC_DAYS * 864e5)

    for (const imapFolder of selectableFolders) {
      const specialUse = (imapFolder.specialUse as string) || null
      const folder = await prisma.folder.upsert({
        where: { accountId_path: { accountId, path: imapFolder.path } },
        create: { accountId, path: imapFolder.path, name: imapFolder.name, specialUse },
        update: { name: imapFolder.name, specialUse },
      })
      await syncMessages(client, accountId, folder.id, imapFolder.path, since)
      done++
      await redis.publish('account:syncState', JSON.stringify({
        accountId, state: 'SYNCING',
        progress: Math.round((done / total) * 100),
        currentFolder: imapFolder.name,
      }))
    }

    await prisma.mailAccount.update({
      where: { id: accountId },
      data: { syncState: 'IDLE', lastSyncAt: new Date(), lastError: null }
    })
    await redis.publish('account:syncState', JSON.stringify({ accountId, state: 'IDLE', progress: 100 }))
    ensureIdle(accountId).catch(err => log.error({ accountId, err: err.message }, 'idle start failed'))

  } catch (err: any) {
    log.error({ accountId, err: err.message }, 'sync failed')
    await prisma.mailAccount.update({
      where: { id: accountId },
      data: { syncState: 'ERROR', lastError: err.message }
    })
    await redis.publish('account:syncState', JSON.stringify({ accountId, state: 'ERROR', error: err.message }))
  }
}

async function syncMessages(
  client: ImapFlow, accountId: string,
  folderId: string, folderPath: string, since: Date
): Promise<void> {
  let lock
  try { lock = await client.getMailboxLock(folderPath) }
  catch (err: any) { log.warn({ folderPath, err: err.message }, 'cannot open folder'); return }

  try {
    const mailbox = client.mailbox as any
    const serverUidValidity = BigInt(mailbox?.uidValidity ?? 0)
    const serverUidNext = BigInt(mailbox?.uidNext ?? 1)

    const storedFolder = await prisma.folder.findUnique({ where: { id: folderId } })
    const storedUidValidity = storedFolder?.uidValidity
    const storedUidNext = storedFolder?.uidNext ?? BigInt(1)

    // uidValidity changed → all stored UIDs are invalid
    if (storedUidValidity && storedUidValidity !== serverUidValidity) {
      await prisma.message.deleteMany({ where: { folderId } })
    }

    const isFirstSync = !storedUidValidity || storedUidValidity !== serverUidValidity

    if (isFirstSync) {
      // collect all messages into batches, then bulk-upsert
      await batchFetchAndUpsert(client, accountId, folderId, { since }, false)
    } else if (serverUidNext > storedUidNext) {
      // only fetch new UIDs
      const range = `${storedUidNext}:*`
      await batchFetchAndUpsert(client, accountId, folderId, range, true, { uid: true })
    }

    // incremental flag refresh: last 7 days only (avoids scanning full folder)
    if (!isFirstSync) {
      const recent = new Date(Date.now() - 7 * 864e5)
      const flagUpdates: Array<{ uid: bigint; isRead: boolean; isFlagged: boolean; isAnswered: boolean }> = []
      for await (const msg of client.fetch({ since: recent }, { uid: true, flags: true })) {
        const flags: Set<string> = msg.flags ?? new Set()
        flagUpdates.push({
          uid: BigInt(msg.uid),
          isRead: flags.has('\\Seen'),
          isFlagged: flags.has('\\Flagged'),
          isAnswered: flags.has('\\Answered'),
        })
      }
      // batch flag updates — one transaction
      if (flagUpdates.length > 0) {
        await prisma.$transaction(
          flagUpdates.map(u => prisma.message.updateMany({
            where: { accountId, folderId, uid: u.uid },
            data: { isRead: u.isRead, isFlagged: u.isFlagged, isAnswered: u.isAnswered }
          }))
        )
      }
    }

    await prisma.folder.update({
      where: { id: folderId },
      data: { uidValidity: serverUidValidity, uidNext: serverUidNext }
    })
    await refreshCounts(accountId, folderId)

  } finally {
    lock.release()
  }
}

// Batch fetch envelopes and upsert in chunks — eliminates N+1 per message
async function batchFetchAndUpsert(
  client: ImapFlow,
  accountId: string,
  folderId: string,
  range: any,
  notify: boolean,
  options?: object
): Promise<void> {
  const batch: any[] = []

  for await (const msg of client.fetch(
    range,
    { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true },
    options
  )) {
    batch.push(msg)
    if (batch.length >= BATCH_SIZE) {
      await upsertBatch(accountId, folderId, batch, notify)
      batch.length = 0
    }
  }
  if (batch.length > 0) await upsertBatch(accountId, folderId, batch, notify)
}

async function upsertBatch(
  accountId: string, folderId: string, msgs: any[], notify: boolean
): Promise<void> {
  const uids = msgs.map(m => BigInt(m.uid))

  // single query to find all existing messages in this batch
  const existing = await prisma.message.findMany({
    where: { accountId, folderId, uid: { in: uids } },
    select: { id: true, uid: true }
  })
  const existingByUid = new Map(existing.map(e => [e.uid.toString(), e.id]))

  const toCreate: any[] = []
  const toUpdate: Array<{ id: string; isRead: boolean; isFlagged: boolean; isAnswered: boolean }> = []

  for (const msg of msgs) {
    const uid = BigInt(msg.uid)
    const flags: Set<string> = msg.flags ?? new Set()
    const env = msg.envelope ?? {}

    const isRead = flags.has('\\Seen')
    const isFlagged = flags.has('\\Flagged')
    const isAnswered = flags.has('\\Answered')

    const existingId = existingByUid.get(uid.toString())
    if (existingId) {
      toUpdate.push({ id: existingId, isRead, isFlagged, isAnswered })
    } else {
      toCreate.push({
        accountId, folderId, uid,
        messageId: env.messageId || null,
        inReplyTo: env.inReplyTo || null,
        subject: env.subject || '(sem assunto)',
        fromName: env.from?.[0]?.name || null,
        fromEmail: env.from?.[0]?.address || null,
        toJson: JSON.stringify(env.to || []),
        ccJson: env.cc ? JSON.stringify(env.cc) : null,
        date: env.date || msg.internalDate || new Date(),
        isRead, isFlagged, isAnswered,
        hasAttachments: hasAttach(msg.bodyStructure),
        size: msg.size || 0,
      })
    }
  }

  // createMany is O(1) round-trips vs N creates
  if (toCreate.length > 0) {
    await prisma.message.createMany({ data: toCreate, skipDuplicates: true })
  }

  // batch flag updates in one transaction
  if (toUpdate.length > 0) {
    await prisma.$transaction(
      toUpdate.map(u => prisma.message.update({
        where: { id: u.id },
        data: { isRead: u.isRead, isFlagged: u.isFlagged, isAnswered: u.isAnswered }
      }))
    )
  }

  // notify only for new messages
  if (notify && toCreate.length > 0) {
    // fetch the created IDs to emit events
    const created = await prisma.message.findMany({
      where: { accountId, folderId, uid: { in: toCreate.map(m => m.uid) } },
      select: { id: true, uid: true, subject: true, fromName: true, fromEmail: true }
    })
    for (const msg of created) {
      await redis.publish('mail:new', JSON.stringify({
        accountId, folderId, messageId: msg.id,
        subject: msg.subject, fromEmail: msg.fromEmail, fromName: msg.fromName,
      }))
    }
  }
}

function hasAttach(struct: any): boolean {
  if (!struct) return false
  if (typeof struct.disposition === 'string' && struct.disposition.toLowerCase() === 'attachment') return true
  if (Array.isArray(struct.childNodes)) return struct.childNodes.some(hasAttach)
  return false
}

async function refreshCounts(accountId: string, folderId: string): Promise<void> {
  const [totalMessages, unreadCount] = await Promise.all([
    prisma.message.count({ where: { folderId } }),
    prisma.message.count({ where: { folderId, isRead: false } }),
  ])
  await prisma.folder.update({ where: { id: folderId }, data: { totalMessages, unreadCount } })
  await redis.publish('folder:counts', JSON.stringify({ accountId, folderId, unreadCount, totalMessages }))
}

// ── IMAP IDLE ────────────────────────────────────────────────────────────────
const idleStarted = new Set<string>()

export async function ensureIdle(accountId: string): Promise<void> {
  if (idleStarted.has(accountId) && pool.get(accountId, 'idle')) return
  idleStarted.delete(accountId)

  const account = await prisma.mailAccount.findUnique({ where: { id: accountId } })
  if (!account) return

  const client = await pool.connect(accountId, 'idle', imapOptions(account))
  idleStarted.add(accountId)

  await client.mailboxOpen('INBOX')
  log.info({ accountId, email: account.emailAddress }, 'IDLE watching INBOX')

  client.on('exists', (data: any) => {
    handleNewMessages(client, accountId, data).catch(err =>
      log.error({ accountId, err: err.message }, 'idle new-message handler failed'))
  })

  client.on('flags', (data: any) => {
    handleFlagChange(accountId, data).catch(() => {})
  })

  client.on('close', () => {
    idleStarted.delete(accountId)
    log.warn({ accountId }, 'IDLE closed, reconnecting in 30s')
    setTimeout(() => ensureIdle(accountId).catch(e => log.error({ accountId, err: e.message }, 'idle reconnect failed')), 30_000)
  })
}

async function handleNewMessages(client: ImapFlow, accountId: string, data: any): Promise<void> {
  if (!data || typeof data.count !== 'number') return
  const prevCount = typeof data.prevCount === 'number' ? data.prevCount : data.count - 1
  if (data.count <= prevCount) return

  const folder = await prisma.folder.findFirst({ where: { accountId, path: 'INBOX' } })
  if (!folder) return

  const seqRange = `${prevCount + 1}:${data.count}`
  await batchFetchAndUpsert(client, accountId, folder.id, seqRange, true)
  await refreshCounts(accountId, folder.id)
}

async function handleFlagChange(accountId: string, data: any): Promise<void> {
  if (!data?.uid) return
  const folder = await prisma.folder.findFirst({ where: { accountId, path: 'INBOX' } })
  if (!folder) return
  const flags: Set<string> = data.flags ?? new Set()
  const msg = await prisma.message.findUnique({
    where: { accountId_folderId_uid: { accountId, folderId: folder.id, uid: BigInt(data.uid) } }
  })
  if (!msg) return
  await prisma.message.update({
    where: { id: msg.id },
    data: {
      isRead: flags.has('\\Seen'),
      isFlagged: flags.has('\\Flagged'),
      isAnswered: flags.has('\\Answered'),
    }
  })
  await redis.publish('mail:updated', JSON.stringify({
    accountId, messageId: msg.id,
    isRead: flags.has('\\Seen'), isFlagged: flags.has('\\Flagged'),
  }))
  await refreshCounts(accountId, folder.id)
}

// ── Lazy body fetch ──────────────────────────────────────────────────────────
export async function fetchBody(messageId: string): Promise<void> {
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: { folder: { include: { account: true } } }
  })
  if (!msg || msg.bodyFetchedAt) return

  const client = await getOpsClient(msg.folder.account.id)
  const lock = await client.getMailboxLock(msg.folder.path)
  try {
    const rawMsg = await client.fetchOne(String(msg.uid), { source: true }, { uid: true })
    if (!rawMsg || !(rawMsg as any).source) {
      await prisma.message.update({
        where: { id: messageId },
        data: { bodyFetchedAt: new Date(), textBody: '(mensagem não encontrada no servidor)' }
      })
      return
    }

    const parsed = await simpleParser((rawMsg as any).source)

    await prisma.message.update({
      where: { id: messageId },
      data: {
        htmlBody: typeof parsed.html === 'string' ? parsed.html : null,
        textBody: parsed.text || null,
        preview: (parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 140),
        bodyFetchedAt: new Date(),
      }
    })

    await redis.publish('mail:bodyReady', JSON.stringify({ messageId, accountId: msg.accountId }))

    if ((parsed.attachments || []).length > 0) {
      await prisma.attachment.createMany({
        data: (parsed.attachments || []).map(att => ({
          id: `${messageId}-${att.checksum || Math.random().toString(36).slice(2)}`,
          messageId,
          filename: att.filename || 'sem-nome',
          mimeType: att.contentType || 'application/octet-stream',
          size: att.size || 0,
          contentId: att.cid || null,
          isInline: att.contentDisposition === 'inline',
        })),
        skipDuplicates: true,
      })
    }
  } finally {
    lock.release()
  }
}
