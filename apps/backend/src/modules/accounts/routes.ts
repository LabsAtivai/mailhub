import { Router, Response } from 'express'
import { z } from 'zod'
import net from 'net'
import dns from 'dns/promises'
import { prisma } from '../../lib/prisma'
import { encrypt, decrypt } from '../../lib/crypto'
import { requireAuth, AuthRequest } from '../../middleware/auth'
import { redis } from '../../lib/redis'

const router = Router()
router.use(requireAuth)

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
  /^::1$/, /^fc/, /^fd/, /^169\.254\./,
]

async function isPrivateHost(host: string): Promise<boolean> {
  if (net.isIP(host)) return PRIVATE_RANGES.some(r => r.test(host))
  try {
    const addrs = await dns.resolve4(host)
    return addrs.some(a => PRIVATE_RANGES.some(r => r.test(a)))
  } catch { return false }
}

// GET /accounts
router.get('/', async (req: AuthRequest, res: Response) => {
  const accounts = await prisma.mailAccount.findMany({
    where: { userId: req.userId! },
    select: {
      id: true, displayName: true, emailAddress: true,
      incomingHost: true, incomingPort: true,
      outgoingHost: true, outgoingPort: true,
      username: true, tlsMode: true,
      syncState: true, lastSyncAt: true, lastError: true, createdAt: true
    }
  })
  res.json(accounts)
})

// POST /accounts/test
router.post('/test', async (req: AuthRequest, res: Response) => {
  const parsed = AccountSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  const d = parsed.data
  if (!d.password) { res.status(400).json({ error: 'Senha obrigatória para teste' }); return }
  if (await isPrivateHost(d.incomingHost)) { res.status(400).json({ error: 'Host inválido' }); return }

  const { ImapFlow } = await import('imapflow')
  const client = new ImapFlow({
    host: d.incomingHost, port: d.incomingPort,
    secure: d.tlsMode === 'TLS',
    auth: { user: d.username, pass: d.password },
    logger: false,
  })
  try {
    await client.connect()
    await client.logout()
    res.json({ ok: true })
  } catch (e: any) {
    res.status(400).json({ error: e.message })
  }
})

// POST /accounts
router.post('/', async (req: AuthRequest, res: Response) => {
  const parsed = AccountSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  const d = parsed.data
  if (!d.password) { res.status(400).json({ error: 'Senha obrigatória' }); return }
  if (await isPrivateHost(d.incomingHost)) { res.status(400).json({ error: 'Host inválido' }); return }

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

  res.status(201).json({
    id: account.id, displayName: account.displayName,
    emailAddress: account.emailAddress, syncState: account.syncState, createdAt: account.createdAt
  })
})

// PATCH /accounts/:id
router.patch('/:id', async (req: AuthRequest, res: Response) => {
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
  })
  const parsed = Schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }

  const { password, ...rest } = parsed.data
  const data: any = { ...rest }
  if (password) data.encryptedPassword = encrypt(password)

  const updated = await prisma.mailAccount.update({
    where: { id: account.id }, data,
    select: { id: true, displayName: true, emailAddress: true, syncState: true }
  })
  res.json(updated)
})

// POST /accounts/:id/sync
router.post('/:id/sync', async (req: AuthRequest, res: Response) => {
  const account = await prisma.mailAccount.findFirst({ where: { id: req.params.id, userId: req.userId! } })
  if (!account) { res.status(404).json({ error: 'Not found' }); return }
  await redis.publish('mailhub:sync:start', JSON.stringify({ accountId: account.id }))
  res.json({ ok: true })
})

// DELETE /accounts/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const account = await prisma.mailAccount.findFirst({ where: { id: req.params.id, userId: req.userId! } })
  if (!account) { res.status(404).json({ error: 'Not found' }); return }
  await prisma.mailAccount.delete({ where: { id: account.id } })
  res.json({ ok: true })
})

export default router
