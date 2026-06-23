import { Router, Response, NextFunction } from 'express'
import { prisma } from '../../lib/prisma'
import { encrypt } from '../../lib/crypto'
import { redis } from '../../lib/redis'
import { requireAuth, requireAdmin, AuthRequest } from '../../middleware/auth'
import { scope } from '../../lib/logger'
import { z } from 'zod'

const log = scope('admin')
const router = Router()
router.use(requireAuth, requireAdmin)

function wrap(fn: (req: AuthRequest, res: Response) => Promise<void>) {
  return (req: AuthRequest, res: Response, next: NextFunction) => fn(req, res).catch(next)
}

// GET /admin/stats — dashboard stats
router.get('/stats', wrap(async (_req, res) => {
  const [users, accounts, messages, folders] = await Promise.all([
    prisma.user.count(),
    prisma.mailAccount.count(),
    prisma.message.count(),
    prisma.folder.count(),
  ])
  const syncingAccounts = await prisma.mailAccount.count({ where: { syncState: 'SYNCING' } })
  const errorAccounts = await prisma.mailAccount.count({ where: { syncState: 'ERROR' } })
  res.json({ users, accounts, messages, folders, syncingAccounts, errorAccounts })
}))

// GET /admin/users — list all users with account counts
router.get('/users', wrap(async (_req, res) => {
  const users = await prisma.user.findMany({
    select: {
      id: true, name: true, email: true, role: true, createdAt: true,
      _count: { select: { accounts: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  res.json(users.map(u => ({
    id: u.id, name: u.name, email: u.email, role: u.role,
    createdAt: u.createdAt, accountCount: u._count.accounts,
  })))
}))

// GET /admin/users/:id — user detail with all accounts
router.get('/users/:id', wrap(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, name: true, email: true, role: true, createdAt: true,
      accounts: {
        select: {
          id: true, displayName: true, emailAddress: true,
          incomingHost: true, incomingPort: true,
          outgoingHost: true, outgoingPort: true,
          username: true, tlsMode: true,
          syncEnabled: true, syncState: true,
          lastSyncAt: true, lastError: true, createdAt: true,
          _count: { select: { folders: true } },
        },
      },
    },
  })
  if (!user) { res.status(404).json({ error: 'Usuário não encontrado' }); return }
  res.json(user)
}))

// PATCH /admin/users/:id — update user (role, name)
const UpdateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(['user', 'admin']).optional(),
})

router.patch('/users/:id', wrap(async (req, res) => {
  const parsed = UpdateUserSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  const user = await prisma.user.findUnique({ where: { id: req.params.id } })
  if (!user) { res.status(404).json({ error: 'Usuário não encontrado' }); return }
  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data: parsed.data,
    select: { id: true, name: true, email: true, role: true },
  })
  log.info({ adminId: req.userId, targetId: req.params.id, changes: parsed.data }, 'user updated by admin')
  res.json(updated)
}))

// DELETE /admin/users/:id — delete user and all their data
router.delete('/users/:id', wrap(async (req, res) => {
  if (req.params.id === req.userId) {
    res.status(400).json({ error: 'Não é possível excluir a si mesmo' }); return
  }
  const user = await prisma.user.findUnique({ where: { id: req.params.id } })
  if (!user) { res.status(404).json({ error: 'Usuário não encontrado' }); return }
  await prisma.user.delete({ where: { id: req.params.id } })
  log.info({ adminId: req.userId, targetId: req.params.id, email: user.email }, 'user deleted by admin')
  res.json({ ok: true })
}))

// GET /admin/accounts — list all mail accounts
router.get('/accounts', wrap(async (_req, res) => {
  const accounts = await prisma.mailAccount.findMany({
    select: {
      id: true, displayName: true, emailAddress: true,
      incomingHost: true, incomingPort: true,
      outgoingHost: true, outgoingPort: true,
      username: true, tlsMode: true,
      syncEnabled: true, syncState: true,
      lastSyncAt: true, lastError: true, createdAt: true,
      user: { select: { id: true, name: true, email: true } },
      _count: { select: { folders: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  res.json(accounts)
}))

// POST /admin/accounts — create account for any user
const CreateAccountSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().min(1),
  emailAddress: z.string().email(),
  incomingHost: z.string().min(1),
  incomingPort: z.number().int().default(993),
  outgoingHost: z.string().min(1),
  outgoingPort: z.number().int().default(465),
  username: z.string().min(1),
  password: z.string().min(1),
  tlsMode: z.enum(['TLS', 'STARTTLS']).default('TLS'),
})

router.post('/accounts', wrap(async (req, res) => {
  const parsed = CreateAccountSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  const d = parsed.data

  const user = await prisma.user.findUnique({ where: { id: d.userId } })
  if (!user) { res.status(404).json({ error: 'Usuário não encontrado' }); return }

  const account = await prisma.mailAccount.create({
    data: {
      userId: d.userId,
      displayName: d.displayName,
      emailAddress: d.emailAddress,
      incomingHost: d.incomingHost,
      incomingPort: d.incomingPort,
      outgoingHost: d.outgoingHost,
      outgoingPort: d.outgoingPort,
      username: d.username,
      encryptedPassword: encrypt(d.password),
      tlsMode: d.tlsMode,
    },
  })

  await redis.publish('mailhub:sync:start', JSON.stringify({ accountId: account.id }))
  log.info({ adminId: req.userId, accountId: account.id, userId: d.userId }, 'account created by admin')
  res.status(201).json(account)
}))

// PATCH /admin/accounts/:id — update account
const UpdateAccountSchema = z.object({
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

router.patch('/accounts/:id', wrap(async (req, res) => {
  const parsed = UpdateAccountSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  const account = await prisma.mailAccount.findUnique({ where: { id: req.params.id } })
  if (!account) { res.status(404).json({ error: 'Conta não encontrada' }); return }

  const { password, ...rest } = parsed.data
  const data: Record<string, unknown> = { ...rest }
  if (password) data.encryptedPassword = encrypt(password)

  const updated = await prisma.mailAccount.update({
    where: { id: req.params.id }, data,
    select: {
      id: true, displayName: true, emailAddress: true,
      syncEnabled: true, syncState: true,
    },
  })
  log.info({ adminId: req.userId, accountId: req.params.id }, 'account updated by admin')
  res.json(updated)
}))

// DELETE /admin/accounts/:id
router.delete('/accounts/:id', wrap(async (req, res) => {
  const account = await prisma.mailAccount.findUnique({ where: { id: req.params.id } })
  if (!account) { res.status(404).json({ error: 'Conta não encontrada' }); return }
  await prisma.mailAccount.delete({ where: { id: req.params.id } })
  log.info({ adminId: req.userId, accountId: req.params.id }, 'account deleted by admin')
  res.json({ ok: true })
}))

// POST /admin/accounts/:id/sync — force sync
router.post('/accounts/:id/sync', wrap(async (req, res) => {
  const account = await prisma.mailAccount.findUnique({ where: { id: req.params.id } })
  if (!account) { res.status(404).json({ error: 'Conta não encontrada' }); return }
  await redis.publish('mailhub:sync:start', JSON.stringify({ accountId: account.id }))
  res.json({ ok: true })
}))

export default router
