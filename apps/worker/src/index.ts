import 'dotenv/config'
import { initSentry, Sentry } from './lib/sentry'
initSentry()
import { z } from 'zod'
import { redis } from './lib/redis'
import { pool } from './lib/imapPool'
import { syncAccount, syncMessages, refreshCounts, purgeExpiredTrash, fetchBody, refreshFlags, getInteractiveClient, markRecentlySent, ACCOUNT_ACTIVE_THRESHOLD_MS, SYNC_DAYS } from './sync/syncAccount'
import { prisma } from './lib/prisma'
import { logger } from './lib/logger'
import { AccountSerialQueue } from './lib/serialQueue'
import { runDailyReport } from './report/dailyReport'
import { cleanupExpiredLargeAttachments } from './jobs/cleanupLargeAttachments'

logger.info('starting mailhub-worker')
if (process.env.IMAP_PROXY_URL) {
  // Proxies autenticados costumam vir como protocolo://usuario:senha@host:porta
  // — logar a URL inteira vazaria essa senha em todo boot do worker.
  const redactedProxy = process.env.IMAP_PROXY_URL.replace(/\/\/[^@/]+@/, '//***:***@')
  logger.info({ proxy: redactedProxy }, 'IMAP proxy configured')
}

// Rede de segurança de última instância: uma exceção não tratada aqui derruba
// o processo inteiro (todas as ~1000 conexões IDLE de uma vez) e, na volta, o
// boot sync resincroniza tudo de novo, sobrecarregando o host compartilhado
// — foi exatamente o que causou o crash "Already logged out" em produção.
// As causas conhecidas (ImapFlow, Redis) já têm listener próprio; isto aqui é
// só o último resort pra qualquer coisa inesperada não derrubar o worker.
process.on('uncaughtException', (err: Error) => {
  logger.error({ err: err.message, stack: err.stack }, 'uncaught exception — worker seguiu rodando')
  Sentry.captureException(err)
})
process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection — worker seguiu rodando')
  Sentry.captureException(reason)
})

const sub = redis.duplicate()
sub.on('error', (err: Error) => logger.error({ err: err.message }, 'redis sub connection error'))

sub.subscribe(
  'mailhub:sync:start',
  'mailhub:fetch:body',
  'mailhub:flag:refresh',
  'mailhub:flag:update',
  'mailhub:message:move',
  'mailhub:message:delete',
  'mailhub:sent:append',
  'mailhub:fetch:attachment',
  'mailhub:report:run',
  (err) => { if (err) logger.error({ err }, 'redis subscribe error') }
)

const SyncStartSchema = z.object({ accountId: z.string() })
const FetchBodySchema = z.object({ messageId: z.string() })
const FlagRefreshSchema = z.object({
  messageId: z.string(), accountId: z.string(), folderId: z.string(), uid: z.string(),
})
const FlagUpdateSchema = z.object({
  accountId: z.string(), uid: z.string(), messageId: z.string(),
  isRead: z.boolean().optional(), isFlagged: z.boolean().optional(),
  isAnswered: z.boolean().optional(),
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

const accountQueue = new AccountSerialQueue()

function runSerialForAccount(accountId: string, task: () => Promise<void>): Promise<void> {
  return accountQueue.run(accountId, task)
}

sub.on('message', async (channel: string, message: string) => {
  try {
    const raw = JSON.parse(message)
    switch (channel) {
      case 'mailhub:sync:start': {
        const p = SyncStartSchema.parse(raw)
        await runSerialForAccount(p.accountId, () => syncAccount(p.accountId))
        break
      }
      case 'mailhub:fetch:body': {
        const p = FetchBodySchema.parse(raw)
        await fetchBody(p.messageId)
        break
      }
      case 'mailhub:flag:refresh': {
        const p = FlagRefreshSchema.parse(raw)
        await runSerialForAccount(p.accountId, () => refreshFlags(p.messageId))
        break
      }
      case 'mailhub:flag:update': {
        const p = FlagUpdateSchema.parse(raw)
        await runSerialForAccount(p.accountId, () => handleFlagUpdate(p))
        break
      }
      case 'mailhub:message:move': {
        const p = MoveSchema.parse(raw)
        await runSerialForAccount(p.accountId, () => handleMove(p))
        break
      }
      case 'mailhub:message:delete': {
        const p = DeleteSchema.parse(raw)
        await runSerialForAccount(p.accountId, () => handleDelete(p))
        break
      }
      case 'mailhub:sent:append': {
        const p = SentAppendSchema.parse(raw)
        await runSerialForAccount(p.accountId, () => handleSentAppend(p))
        break
      }
      case 'mailhub:fetch:attachment': {
        const p = FetchAttachmentSchema.parse(raw)
        await runSerialForAccount(p.accountId, () => handleFetchAttachment(p))
        break
      }
      case 'mailhub:report:run': {
        // Disparo manual (botão no admin) — ignora o lock diário do
        // agendador de propósito, pra permitir reenviar o relatório quantas
        // vezes precisar durante teste. Só evita dois cliques simultâneos
        // rodando a classificação em paralelo.
        const running = await redis.set('mailhub:report:running', '1', 'EX', 5 * 60, 'NX')
        if (!running) { logger.warn('daily report manual trigger ignored — already running'); break }
        try {
          const { dateKey } = saoPauloNow()
          await runDailyReport(dateKey)
        } catch (err) {
          logger.error({ err: err instanceof Error ? err.message : String(err) }, 'daily report manual trigger error')
        } finally {
          await redis.del('mailhub:report:running')
        }
        break
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error({ channel, err: errMsg }, 'command handler error')
  }
})

interface FlagPayload { accountId: string; uid: string; messageId: string; isRead?: boolean; isFlagged?: boolean; isAnswered?: boolean }

async function handleFlagUpdate(payload: FlagPayload) {
  const { accountId, uid, isRead, isFlagged, isAnswered, messageId } = payload
  const msg = await prisma.message.findUnique({ where: { id: messageId }, include: { folder: true } })
  if (!msg) return

  const client = await getInteractiveClient(accountId)
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
    if (typeof isAnswered === 'boolean') {
      if (isAnswered) await client.messageFlagsAdd(uid, ['\\Answered'], { uid: true })
      else await client.messageFlagsRemove(uid, ['\\Answered'], { uid: true })
    }
  } finally {
    lock.release()
  }

  const update: Record<string, unknown> = { accountId, messageId }
  if (typeof isRead === 'boolean') update.isRead = isRead
  if (typeof isFlagged === 'boolean') update.isFlagged = isFlagged
  if (typeof isAnswered === 'boolean') update.isAnswered = isAnswered
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

  const client = await getInteractiveClient(accountId)
  const lock = await client.getMailboxLock(source.path)
  try {
    await client.messageMove(uid, target.path, { uid: true })
  } finally {
    lock.release()
  }

  await prisma.message.delete({ where: { id: messageId } }).catch(() => {})
  await redis.publish('mail:deleted', JSON.stringify({ accountId, messageId, folderId: sourceFolderId }))
  // Sem isso, a mensagem some da pasta de origem mas só aparece na pasta de
  // destino no próximo sync periódico (até 30min) — o usuário acha que sumiu.
  // syncAccount(accountId) completo (TODAS as pastas) era caro demais pra
  // rodar aqui: numa triagem com vários move/delete seguidos da MESMA conta,
  // cada um fila atrás do resync completo do anterior (fila serial por
  // conta) — se o usuário recarregasse antes da fila esvaziar, via mensagem
  // "voltando" porque o delete dela ainda nem tinha rodado. Sincronizar só a
  // pasta de destino resolve o mesmo problema sem o custo de vasculhar pastas
  // que não mudaram; refreshCounts na origem (sem IMAP, só COUNT no Postgres)
  // mantém o contador de não lidos dela correto sem precisar do sync inteiro.
  const since = new Date(Date.now() - SYNC_DAYS * 864e5)
  await Promise.all([
    syncMessages(client, accountId, target.id, target.path, since, false, target.specialUse === '\\Trash'),
    refreshCounts(accountId, sourceFolderId),
  ])
}

interface DeletePayload { accountId: string; uid: string; messageId: string; folderId: string; trashFolderId?: string | null }

async function handleDelete(payload: DeletePayload) {
  const { accountId, uid, folderId, trashFolderId, messageId } = payload
  const source = await prisma.folder.findUnique({ where: { id: folderId } })
  if (!source) return

  const client = await getInteractiveClient(accountId)
  const lock = await client.getMailboxLock(source.path)
  let trash: { id: string; path: string } | null = null
  try {
    if (trashFolderId) {
      trash = await prisma.folder.findUnique({ where: { id: trashFolderId } })
      if (trash) await client.messageMove(uid, trash.path, { uid: true })
    } else {
      await client.messageDelete(uid, { uid: true })
    }
  } finally {
    lock.release()
  }

  await prisma.message.delete({ where: { id: messageId } }).catch(() => {})
  await redis.publish('mail:deleted', JSON.stringify({ accountId, messageId, folderId }))
  // Mesma razão do handleMove: sem isso a mensagem só aparece na Lixeira no
  // próximo sync periódico quando foi um soft-delete (moveu pra trashFolderId).
  // Só a pasta de destino, não a conta inteira (ver comentário em handleMove).
  if (trash) {
    const since = new Date(Date.now() - SYNC_DAYS * 864e5)
    await Promise.all([
      syncMessages(client, accountId, trash.id, trash.path, since, false, true),
      refreshCounts(accountId, folderId),
    ])
  } else {
    await refreshCounts(accountId, folderId)
  }
}

// Tenta achar a pasta Sent de verdade no servidor (não só o que já foi
// sincronizado pro Postgres — pode estar desatualizado ou incompleto), e cria
// uma se realmente não existir nenhuma. Contas que nunca mandaram e-mail por
// nenhum cliente antes do MailHub às vezes simplesmente não têm essa pasta no
// servidor ainda; sem isso, o APPEND falhava pra sempre, silenciosamente.
async function resolveSentFolderPath(accountId: string, client: Awaited<ReturnType<typeof getInteractiveClient>>): Promise<string | null> {
  try {
    const folders = await client.list()
    const bySpecialUse = folders.find(f => (f.specialUse as string | undefined) === '\\Sent')
    if (bySpecialUse) return bySpecialUse.path
    const byName = folders.find(f => /sent/i.test(f.name) || /sent/i.test(f.path))
    if (byName) return byName.path

    const created = await client.mailboxCreate(['Sent'])
    logger.info({ accountId, path: created.path, created: created.created }, 'pasta Sent criada no servidor IMAP')
    return created.path
  } catch (err: unknown) {
    logger.error({ accountId, err: err instanceof Error ? err.message : String(err) }, 'failed to find/create Sent folder on IMAP')
    return null
  }
}

// ── sent append: copy sent message to IMAP Sent folder ──────────────────────
async function handleSentAppend(payload: { accountId: string; messageId?: string }) {
  const { accountId, messageId } = payload
  // Alguns provedores devolvem uma cópia do envio direto na INBOX; marcar o
  // Message-ID como "recém-enviado" evita que essa cópia seja tratada como
  // e-mail novo recebido (ver syncAccount.ts).
  if (messageId) await markRecentlySent(accountId, messageId)

  // guardado pra aplicar DEPOIS do syncAccount() no final — senão o próprio
  // resync (que limpa lastError ao terminar com sucesso) apaga esse aviso na
  // mesma hora em que ele é gravado.
  let appendError: string | null = null

  if (messageId) {
    const rawKey = `mailhub:sentraw:${accountId}:${messageId}`
    const rawBase64 = await redis.get(rawKey)
    if (rawBase64) {
      try {
        const client = await getInteractiveClient(accountId)
        // Postgres primeiro (rápido, cobre o caso comum); só faz LIST/CREATE
        // ao vivo no servidor se a sincronização local não conhece a pasta.
        const cached = await prisma.folder.findFirst({
          where: { accountId, OR: [
            { specialUse: '\\Sent' },
            { path: { equals: 'Sent', mode: 'insensitive' } },
            { path: { equals: 'INBOX.Sent', mode: 'insensitive' } },
          ] },
        })
        const sentPath = cached?.path ?? await resolveSentFolderPath(accountId, client)
        if (sentPath) {
          await client.append(sentPath, Buffer.from(rawBase64, 'base64'), ['\\Seen'])
          await redis.del(rawKey)
        } else {
          logger.error({ accountId, messageId }, 'no Sent folder available (nem encontrada nem criável), e-mail enviado não gravado em nenhuma pasta Sent')
          appendError = 'Não foi possível encontrar nem criar a pasta Enviados no servidor'
        }
      } catch (err: unknown) {
        // err.message do ImapFlow só diz "Command failed" genericamente. O
        // motivo de verdade fica em propriedades extras do objeto de erro
        // (responseText, responseStatus, code...), que variam conforme o
        // tipo de falha — em vez de apostar em nomes específicos, despeja
        // TODAS as propriedades próprias do erro pra não ficar cego de novo.
        const dump: Record<string, unknown> = {}
        if (err && typeof err === 'object') {
          for (const key of Object.getOwnPropertyNames(err)) {
            try { dump[key] = (err as Record<string, unknown>)[key] } catch { /* ignore */ }
          }
        }
        logger.error(
          { accountId, messageId, err: err instanceof Error ? err.message : String(err), errDump: dump },
          'failed to append sent message to IMAP Sent folder'
        )
        const responseText = typeof dump.responseText === 'string' ? dump.responseText : null
        appendError = responseText ? `Falha ao salvar em Enviados: ${responseText}` : 'Falha ao salvar o e-mail enviado na pasta Enviados'
      }
    } else {
      logger.warn({ accountId, messageId }, 'no raw MIME cached for sent message, cannot append to Sent')
    }
  }

  await syncAccount(accountId)

  // Corpo é lazy-loaded por padrão (AP-007) — só é buscado quando alguém abre
  // a mensagem. Um e-mail que o próprio usuário acabou de mandar raramente é
  // reaberto, então sem isso o corpo nunca seria buscado e a mensagem nunca
  // entraria no índice de IA (que exige textBody). Busca o corpo aqui, uma
  // vez, pra fechar esse gap — o resto do pipeline (mail:bodyReady →
  // indexação) já existe e reage sozinho.
  if (messageId) {
    const sentMsg = await prisma.message.findFirst({
      where: { accountId, messageId, bodyFetchedAt: null },
      select: { id: true },
    })
    if (sentMsg) {
      await fetchBody(sentMsg.id).catch((err: unknown) =>
        logger.error({ accountId, messageId: sentMsg.id, err: err instanceof Error ? err.message : String(err) }, 'failed to eager-fetch body of just-sent message')
      )
    }
  }

  // Sem isso, uma causa de infra (cota de disco estourada, por exemplo) fica
  // invisível pro time — só aparece cavando log do worker, como aconteceu
  // aqui. Só aplica se o resync acima não tiver já marcado a conta com ERROR
  // por outro motivo mais urgente (não queremos mascarar isso).
  if (appendError) {
    const account = await prisma.mailAccount.findUnique({ where: { id: accountId }, select: { syncState: true } })
    if (account && account.syncState !== 'ERROR') {
      await prisma.mailAccount.update({ where: { id: accountId }, data: { lastError: appendError } }).catch(() => {})
    }
  }
}

// ── fetch attachment: download attachment content from IMAP ──────────────────
interface AttachmentPayload {
  attachmentId: string; messageId: string; accountId: string
  folderPath: string; uid: string; filename: string; contentId?: string | null
}

async function handleFetchAttachment(payload: AttachmentPayload) {
  const { accountId, folderPath, uid, attachmentId } = payload
  const client = await getInteractiveClient(accountId)
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
    // Sem isso, o comando buscava e parseava o anexo e simplesmente
    // descartava o conteúdo — o endpoint de download nunca tinha o que
    // servir, então o recurso nunca funcionou de fato. TTL curto: é só uma
    // ponte até o usuário clicar "baixar" de novo (ver messages/useCases.ts,
    // requestAttachment).
    await redis.set(`mailhub:attachment:${attachmentId}`, att.content.toString('base64'), 'EX', 600)
    logger.info({ attachmentId, size: att.size }, 'attachment fetched and cached for download')
  } finally {
    lock.release()
  }
}

// ── concurrency-limited task runner ─────────────────────────────────────────
async function runWithConcurrency(
  ids: string[],
  concurrency: number,
  label: string,
  task: (id: string) => Promise<void> = syncAccount,
): Promise<void> {
  const queue = [...ids]
  const results: Array<{ id: string; error?: string }> = []
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const id = queue.shift()!
      try {
        await task(id)
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

// ── periodic incremental sync every 30 minutes ──────────────────────────────
// Intervalo maior reduz a carga de fundo contra o host IMAP compartilhado; o
// usuário tem um botão de atualizar manual (POST /accounts/:id/sync) para não
// depender só disso quando quiser ver algo na hora.
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
}, 30 * 60 * 1000)

// ── expurgo automático da Lixeira a cada 6 horas ────────────────────────────
// Prazo de 15 dias tem folga de sobra — não precisa do intervalo curto do
// sync. runSerialForAccount evita competir com IDLE/sync/delete em andamento
// da mesma conta pelo lock de mailbox (getMailboxLock).
setInterval(async () => {
  try {
    const accounts = await prisma.mailAccount.findMany({
      where: { syncEnabled: true },
      select: { id: true }
    })
    await runWithConcurrency(
      accounts.map(a => a.id), 5, 'trash-purge',
      id => runSerialForAccount(id, () => purgeExpiredTrash(id)),
    )
  } catch (err) {
    const errMsg = err instanceof Error ? (err as Error).message : String(err)
    logger.error({ err: errMsg }, 'trash purge scheduler error')
  }
}, 6 * 60 * 60 * 1000)

// ── expurgo de links de anexo grande vencidos (MinIO) a cada 6 horas ───────
setInterval(async () => {
  try {
    await cleanupExpiredLargeAttachments()
  } catch (err) {
    const errMsg = err instanceof Error ? (err as Error).message : String(err)
    logger.error({ err: errMsg }, 'large attachments cleanup scheduler error')
  }
}, 6 * 60 * 60 * 1000)

// ── relatório diário de triagem (15h horário de Brasília) ──────────────────
// Sem lib de cron (mesmo padrão dos outros schedulers deste arquivo): checa a
// cada minuto se bateu 15:00 em America/Sao_Paulo. Lock no Redis (NX + expira
// em 24h) evita mandar o relatório 2x se o worker reiniciar dentro da mesma
// janela do minuto certo. Se a rodada falhar (ex: OpenAI fora do ar), não
// tenta de novo no mesmo dia — próxima tentativa é 15:00 do dia seguinte.
function saoPauloNow(): { dateKey: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date())
  const get = (type: string) => parts.find(p => p.type === type)?.value || ''
  return { dateKey: `${get('year')}-${get('month')}-${get('day')}`, hhmm: `${get('hour')}:${get('minute')}` }
}

setInterval(async () => {
  const { dateKey, hhmm } = saoPauloNow()
  if (hhmm !== '15:00') return

  const lockKey = `mailhub:report:sent:${dateKey}`
  const acquired = await redis.set(lockKey, '1', 'EX', 24 * 60 * 60, 'NX')
  if (!acquired) return

  try {
    await runDailyReport(dateKey)
  } catch (err) {
    logger.error({ dateKey, err: err instanceof Error ? err.message : String(err) }, 'daily report scheduler error')
  }
}, 60 * 1000)

// ── boot: reset stale SYNCING states + sync only recently-active accounts ──
// Contas inativas já são cobertas pelo ciclo periódico (30min) — não faz
// sentido ressincronizar todas as ~1000 de uma vez a cada reinício (deploy
// normal OU crash inesperado). Essa rajada de conexões contra o host
// compartilhado da HostGator foi o que agravou o incidente de "Already
// logged out": o worker caiu, voltou, tentou resincronizar as 424 contas de
// uma vez, e a sobrecarga gerou uma cascata de ETIMEDOUT/"cannot open
// folder". Só as contas ativas nas últimas horas precisam de resync+IDLE na
// hora; o resto pega o próximo ciclo periódico normalmente.
prisma.mailAccount.updateMany({
  where: { syncState: 'SYNCING' },
  data: { syncState: 'IDLE' },
}).then(({ count }) => {
  if (count > 0) logger.info({ count }, 'reset stale SYNCING accounts')
  return prisma.mailAccount.findMany({
    where: {
      syncEnabled: true,
      lastActiveAt: { gt: new Date(Date.now() - ACCOUNT_ACTIVE_THRESHOLD_MS) },
    },
    select: { id: true },
  })
}).then(accounts => {
  logger.info({ count: accounts.length }, 'contas ativas a sincronizar no boot (inativas ficam pro próximo ciclo periódico)')
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
