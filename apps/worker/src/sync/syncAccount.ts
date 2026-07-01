import { ImapFlow, ImapFlowOptions } from 'imapflow'
import { simpleParser } from 'mailparser'
import { prisma } from '../lib/prisma'
import { decrypt } from '../lib/crypto'
import { redis } from '../lib/redis'
import { pool } from '../lib/imapPool'
import { scope }  from '../lib/logger'

const log = scope('sync')

const SYNC_DAYS = 90
const BATCH_SIZE = 200

const IMAP_PROXY = process.env.IMAP_PROXY_URL || ''

interface ImapAccount {
  id: string
  incomingHost: string
  incomingPort: number
  tlsMode: string
  username: string
  encryptedPassword: string
  syncEnabled: boolean
  syncState: string
  emailAddress: string
}

function imapOptions(account: ImapAccount): ImapFlowOptions {
  const opts: ImapFlowOptions = {
    host: account.incomingHost,
    port: account.incomingPort,
    secure: account.tlsMode === 'TLS',
    auth: { user: account.username, pass: decrypt(account.encryptedPassword) },
  }
  if (IMAP_PROXY) (opts as unknown as Record<string, unknown>).proxy = IMAP_PROXY
  return opts
}

export async function getOpsClient(accountId: string): Promise<ImapFlow> {
  const account = await prisma.mailAccount.findUnique({ where: { id: accountId } })
  if (!account) throw new Error('Account not found')
  const existing = pool.get(accountId, 'ops')
  if (existing) return existing
  return pool.connect(accountId, 'ops', imapOptions(account as ImapAccount))
}

// ── Full / incremental sync ──────────────────────────────────────────────────
export async function syncAccount(accountId: string): Promise<void> {
  const account = await prisma.mailAccount.findUnique({ where: { id: accountId } })
  if (!account || !account.syncEnabled) return

  const { count } = await prisma.mailAccount.updateMany({
    where: { id: accountId, syncState: { not: 'SYNCING' } },
    data: { syncState: 'SYNCING' },
  })
  if (count === 0) return
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
    ensureIdle(accountId).catch(err =>
      log.error({ accountId, err: err instanceof Error ? err.message : String(err) }, 'idle start failed'))

  } catch (err: unknown) {
    const e = err as Record<string, unknown>
    const errMsg = e?.responseText ?? e?.serverResponseCode ?? (err instanceof Error ? err.message : String(err))
    const errCode = String(e?.serverResponseCode ?? '')
    const isAuthError = errCode === 'AUTHENTICATIONFAILED' || String(errMsg).toLowerCase().includes('authentication failed')
    log.error({ accountId, err: String(errMsg), code: errCode, disabledSync: isAuthError }, 'sync failed')
    await prisma.mailAccount.update({
      where: { id: accountId },
      data: {
        syncState: 'ERROR',
        lastError: String(errMsg),
        ...(isAuthError ? { syncEnabled: false } : {}),
      }
    })
    await redis.publish('account:syncState', JSON.stringify({ accountId, state: 'ERROR', error: String(errMsg) }))
  }
}

interface MailboxInfo {
  uidValidity?: number | bigint
  uidNext?: number | bigint
}

async function syncMessages(
  client: ImapFlow, accountId: string,
  folderId: string, folderPath: string, since: Date
): Promise<void> {
  let lock
  try { lock = await client.getMailboxLock(folderPath) }
  catch (err: unknown) {
    log.warn({ folderPath, err: err instanceof Error ? err.message : String(err) }, 'cannot open folder')
    return
  }

  try {
    const mailbox = client.mailbox as MailboxInfo | undefined
    const serverUidValidity = BigInt(mailbox?.uidValidity ?? 0)
    const serverUidNext = BigInt(mailbox?.uidNext ?? 1)

    const storedFolder = await prisma.folder.findUnique({ where: { id: folderId } })
    const storedUidValidity = storedFolder?.uidValidity
    const storedUidNext = storedFolder?.uidNext ?? BigInt(1)

    if (storedUidValidity && storedUidValidity !== serverUidValidity) {
      await prisma.message.deleteMany({ where: { folderId } })
    }

    const isFirstSync = !storedUidValidity || storedUidValidity !== serverUidValidity

    if (isFirstSync) {
      await batchFetchAndUpsert(client, accountId, folderId, { since }, false)
    } else if (serverUidNext > storedUidNext) {
      const range = `${storedUidNext}:*`
      await batchFetchAndUpsert(client, accountId, folderId, range, true, { uid: true })
    }

    if (!isFirstSync) {
      const recent = new Date(Date.now() - SYNC_DAYS * 864e5)
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

async function batchFetchAndUpsert(
  client: ImapFlow,
  accountId: string,
  folderId: string,
  range: unknown,
  notify: boolean,
  options?: object
): Promise<void> {
  const batch: Array<Record<string, unknown>> = []

  for await (const msg of client.fetch(
    range as any,
    { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true },
    options
  )) {
    batch.push(msg as unknown as Record<string, unknown>)
    if (batch.length >= BATCH_SIZE) {
      await upsertBatch(accountId, folderId, batch, notify)
      batch.length = 0
    }
  }
  if (batch.length > 0) await upsertBatch(accountId, folderId, batch, notify)
}

interface Envelope {
  messageId?: string
  inReplyTo?: string
  subject?: string
  from?: Array<{ name?: string; address?: string }>
  to?: Array<{ name?: string; address?: string }>
  cc?: Array<{ name?: string; address?: string }>
  date?: Date
}

async function upsertBatch(
  accountId: string, folderId: string, msgs: Array<Record<string, unknown>>, notify: boolean
): Promise<void> {
  const uids = msgs.map(m => BigInt(m.uid as number))

  const existing = await prisma.message.findMany({
    where: { accountId, folderId, uid: { in: uids } },
    select: { id: true, uid: true }
  })
  const existingByUid = new Map(existing.map(e => [e.uid.toString(), e.id]))

  const toCreate: Array<Record<string, unknown>> = []
  const toUpdate: Array<{ id: string; isRead: boolean; isFlagged: boolean; isAnswered: boolean }> = []

  for (const msg of msgs) {
    const uid = BigInt(msg.uid as number)
    const flags: Set<string> = (msg.flags as Set<string>) ?? new Set()
    const env = (msg.envelope ?? {}) as Envelope

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
        date: env.date || (msg.internalDate as Date) || new Date(),
        isRead, isFlagged, isAnswered,
        hasAttachments: hasAttach(msg.bodyStructure),
        size: (msg.size as number) || 0,
      })
    }
  }

  if (toCreate.length > 0) {
    await prisma.message.createMany({ data: toCreate as any, skipDuplicates: true })
  }

  if (toUpdate.length > 0) {
    await prisma.$transaction(
      toUpdate.map(u => prisma.message.update({
        where: { id: u.id },
        data: { isRead: u.isRead, isFlagged: u.isFlagged, isAnswered: u.isAnswered }
      }))
    )
  }

  if (notify && toCreate.length > 0) {
    const created = await prisma.message.findMany({
      where: { accountId, folderId, uid: { in: toCreate.map(m => m.uid as bigint) } },
      select: { id: true, uid: true, subject: true, fromName: true, fromEmail: true, inReplyTo: true }
    })
    for (const msg of created) {
      await redis.publish('mail:new', JSON.stringify({
        accountId, folderId, messageId: msg.id,
        subject: msg.subject, fromEmail: msg.fromEmail, fromName: msg.fromName,
        inReplyTo: msg.inReplyTo,
      }))
    }
  }
}

function hasAttach(struct: unknown): boolean {
  if (!struct || typeof struct !== 'object') return false
  const s = struct as Record<string, unknown>
  const disp = s.disposition as { type?: string } | undefined
  if (disp?.type?.toLowerCase() === 'attachment') return true
  if (Array.isArray(s.childNodes)) return (s.childNodes as unknown[]).some(hasAttach)
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
const idleRetries = new Map<string, number>()

export async function ensureIdle(accountId: string): Promise<void> {
  if (idleStarted.has(accountId) && pool.get(accountId, 'idle')) return
  idleStarted.delete(accountId)

  const account = await prisma.mailAccount.findUnique({ where: { id: accountId } })
  if (!account) return

  const client = await pool.connect(accountId, 'idle', imapOptions(account as ImapAccount))
  idleStarted.add(accountId)
  idleRetries.delete(accountId)

  await client.mailboxOpen('INBOX')
  log.info({ accountId, email: account.emailAddress }, 'IDLE watching INBOX')

  client.on('exists', (data: { count?: number; prevCount?: number }) => {
    handleNewMessages(client, accountId, data).catch(err =>
      log.error({ accountId, err: err instanceof Error ? err.message : String(err) }, 'idle new-message handler failed'))
  })

  client.on('flags', (data: { uid?: number; flags?: Set<string> }) => {
    handleFlagChange(accountId, data).catch(err =>
      log.error({ accountId, err: err instanceof Error ? err.message : String(err) }, 'idle flag handler failed'))
  })

  client.on('close', () => {
    idleStarted.delete(accountId)
    const retries = idleRetries.get(accountId) ?? 0
    if (retries >= 10) {
      log.error({ accountId, retries }, 'IDLE max retries reached, giving up')
      idleRetries.delete(accountId)
      return
    }
    idleRetries.set(accountId, retries + 1)
    const delay = Math.min(30_000 * Math.pow(2, retries), 300_000)
    log.warn({ accountId, retries: retries + 1, delayMs: delay }, 'IDLE closed, reconnecting')
    setTimeout(() => ensureIdle(accountId).catch(e =>
      log.error({ accountId, err: e instanceof Error ? e.message : String(e) }, 'idle reconnect failed')), delay)
  })
}

async function handleNewMessages(client: ImapFlow, accountId: string, data: { count?: number; prevCount?: number }): Promise<void> {
  if (!data || typeof data.count !== 'number') return
  const prevCount = typeof data.prevCount === 'number' ? data.prevCount : data.count - 1
  if (data.count <= prevCount) return

  const folder = await prisma.folder.findFirst({ where: { accountId, path: 'INBOX' } })
  if (!folder) return

  const storedUidNext = folder.uidNext ?? BigInt(1)
  await batchFetchAndUpsert(client, accountId, folder.id, `${storedUidNext}:*`, true, { uid: true })

  const mailbox = client.mailbox as MailboxInfo | undefined
  const newUidNext = BigInt(mailbox?.uidNext ?? storedUidNext)
  if (newUidNext > storedUidNext) {
    await prisma.folder.update({ where: { id: folder.id }, data: { uidNext: newUidNext } })
  }
  await refreshCounts(accountId, folder.id)
}

async function handleFlagChange(accountId: string, data: { uid?: number; flags?: Set<string> }): Promise<void> {
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
    const source = rawMsg ? (rawMsg as unknown as Record<string, unknown>).source : undefined
    if (!rawMsg || !source) {
      await prisma.message.update({
        where: { id: messageId },
        data: { bodyFetchedAt: new Date(), textBody: '(mensagem não encontrada no servidor)' }
      })
      return
    }

    const parsed = await simpleParser(source as Buffer)

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
        data: (parsed.attachments || []).map((att, idx) => ({
          id: `${messageId}-${att.checksum || idx}`,
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
