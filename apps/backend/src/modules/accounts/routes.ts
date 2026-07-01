import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import net from 'net'
import dns from 'dns/promises'
import { prisma } from '../../lib/prisma'
import { encrypt } from '../../lib/crypto'
import { requireAuth, AuthRequest } from '../../middleware/auth'
import { redis } from '../../lib/redis'
import { scope } from '../../lib/logger'

const log = scope('accounts')
const router = Router()
router.use(requireAuth)

function wrap(fn: (req: AuthRequest, res: Response) => Promise<void>) {
  return (req: AuthRequest, res: Response, next: NextFunction) => fn(req, res).catch(next)
}

const AccountSchema = z.object({
  displayName: z.string().min(1),
  emailAddress: z.string().email(),
  incomingHost: z.string().min(1),
  incomingPort: z.number().int().default(993),
  outgoingHost: z.string().min(1),
  outgoingPort: z.number().int().default(465),
  username: z.string().min(1),
  password: z.string().optional(),
  tlsMode: z.enum(['TLS', 'STARTTLS']).default('TLS'),
})

const PRIVATE_RANGES = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./, /^169\.254\./, /^224\./, /^240\./,
]

const PRIVATE_IPV6 = [
  /^::1$/, /^::$/, /^fc/i, /^fd/i, /^fe80:/i, /^::ffff:127\./i,
  /^::ffff:10\./i, /^::ffff:192\.168\./i, /^::ffff:172\.(1[6-9]|2\d|3[01])\./i,
]

function isPrivateIP(ip: string): boolean {
  if (net.isIPv4(ip)) return PRIVATE_RANGES.some(r => r.test(ip))
  if (net.isIPv6(ip)) return PRIVATE_IPV6.some(r => r.test(ip))
  return false
}

async function isPrivateHost(host: string): Promise<boolean> {
  if (net.isIP(host)) return isPrivateIP(host)
  try {
    const [ipv4, ipv6] = await Promise.allSettled([
      dns.resolve4(host),
      dns.resolve6(host),
    ])
    const addrs: string[] = []
    if (ipv4.status === 'fulfilled') addrs.push(...ipv4.value)
    if (ipv6.status === 'fulfilled') addrs.push(...ipv6.value)
    if (addrs.length === 0) return true
    return addrs.some(isPrivateIP)
  } catch {
    return true
  }
}

// GET /accounts
router.get('/', wrap(async (req: AuthRequest, res: Response) => {
  const accounts = await prisma.mailAccount.findMany({
    where: { userId: req.userId! },
    select: {
      id: true, displayName: true, emailAddress: true,
      incomingHost: true, incomingPort: true,
      outgoingHost: true, outgoingPort: true,
      username: true, tlsMode: true,
      syncState: true, lastSyncAt: true, lastError: true, createdAt: true,
      forwardEnabled: true, forwardTo: true
    }
  })
  res.json(accounts)
}))

// POST /accounts/test
router.post('/test', wrap(async (req: AuthRequest, res: Response) => {
  const parsed = AccountSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  const d = parsed.data
  if (!d.password) { res.status(400).json({ error: 'Senha obrigatória para teste' }); return }
  if (await isPrivateHost(d.incomingHost) || await isPrivateHost(d.outgoingHost)) {
    res.status(400).json({ error: 'Host inválido' }); return
  }

  const { ImapFlow } = await import('imapflow')
  const client = new ImapFlow({
    host: d.incomingHost, port: d.incomingPort,
    secure: d.tlsMode === 'TLS',
    auth: { user: d.username, pass: d.password },
    logger: false,
  })
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout: servidor IMAP não respondeu em 20s')), 20_000)),
    ])
    await client.logout()
    res.json({ ok: true })
  } catch (e: unknown) {
    try { client.close() } catch {}
    const err = e as Record<string, unknown>
    const detail = err?.responseText ?? err?.serverResponseCode ?? (e instanceof Error ? e.message : 'Falha na conexão')
    res.status(400).json({ error: String(detail) })
  }
}))

// POST /accounts
router.post('/', wrap(async (req: AuthRequest, res: Response) => {
  const parsed = AccountSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  const d = parsed.data
  if (!d.password) { res.status(400).json({ error: 'Senha obrigatória' }); return }
  if (await isPrivateHost(d.incomingHost) || await isPrivateHost(d.outgoingHost)) {
    res.status(400).json({ error: 'Host inválido' }); return
  }

  const account = await prisma.mailAccount.create({
    data: {
      userId: req.userId!,
      displayName: d.displayName,
      emailAddress: d.emailAddress,
      incomingHost: d.incomingHost,
      incomingPort: d.incomingPort,
      outgoingHost: d.outgoingHost,
      outgoingPort: d.outgoingPort,
      username: d.username,
      encryptedPassword: encrypt(d.password),
      tlsMode: d.tlsMode,
    }
  })

  await redis.publish('mailhub:sync:start', JSON.stringify({ accountId: account.id }))
  log.info({ userId: req.userId, accountId: account.id }, 'account created')

  res.status(201).json({
    id: account.id, displayName: account.displayName,
    emailAddress: account.emailAddress, syncState: account.syncState, createdAt: account.createdAt
  })
}))

// PATCH /accounts/:id
router.patch('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const account = await prisma.mailAccount.findFirst({ where: { id: req.params.id, userId: req.userId! } })
  if (!account) { res.status(404).json({ error: 'Not found' }); return }

  const Schema = z.object({
    displayName: z.string().min(1).optional(),
    emailAddress: z.string().email().optional(),
    incomingHost: z.string().optional(),
    incomingPort: z.number().int().optional(),
    outgoingHost: z.string().optional(),
    outgoingPort: z.number().int().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    tlsMode: z.enum(['TLS', 'STARTTLS']).optional(),
    syncEnabled: z.boolean().optional(),
    forwardEnabled: z.boolean().optional(),
    forwardTo: z.string().email().nullable().optional(),
  })
  const parsed = Schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }

  if (parsed.data.incomingHost && await isPrivateHost(parsed.data.incomingHost)) {
    res.status(400).json({ error: 'Host inválido' }); return
  }
  if (parsed.data.outgoingHost && await isPrivateHost(parsed.data.outgoingHost)) {
    res.status(400).json({ error: 'Host inválido' }); return
  }

  const { password, syncEnabled, forwardEnabled, forwardTo, ...rest } = parsed.data
  const data: Record<string, unknown> = { ...rest }
  if (typeof syncEnabled === 'boolean') data.syncEnabled = syncEnabled
  if (typeof forwardEnabled === 'boolean') data.forwardEnabled = forwardEnabled
  if (forwardTo !== undefined) data.forwardTo = forwardTo
  if (password) data.encryptedPassword = encrypt(password)

  const updated = await prisma.mailAccount.update({
    where: { id: account.id }, data,
    select: { id: true, displayName: true, emailAddress: true, syncState: true }
  })
  res.json(updated)
}))

// POST /accounts/:id/sync
router.post('/:id/sync', wrap(async (req: AuthRequest, res: Response) => {
  const account = await prisma.mailAccount.findFirst({ where: { id: req.params.id, userId: req.userId! } })
  if (!account) { res.status(404).json({ error: 'Not found' }); return }
  await redis.publish('mailhub:sync:start', JSON.stringify({ accountId: account.id }))
  res.json({ ok: true })
}))

// DELETE /accounts/:id
router.delete('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const account = await prisma.mailAccount.findFirst({ where: { id: req.params.id, userId: req.userId! } })
  if (!account) { res.status(404).json({ error: 'Not found' }); return }
  await prisma.mailAccount.delete({ where: { id: account.id } })
  log.info({ userId: req.userId, accountId: account.id }, 'account deleted')
  res.json({ ok: true })
}))

export default router
