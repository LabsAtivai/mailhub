import { Router, Request, Response, NextFunction } from 'express'
import argon2 from 'argon2'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { prisma } from '../../lib/prisma'
import { signAccess, signRefresh, verifyRefresh } from '../../lib/jwt'
import { requireAuth, AuthRequest } from '../../middleware/auth'
import { v4 as uuid } from 'uuid'
import { scope } from '../../lib/logger'

const log = scope('auth')
const router = Router()

function wrap(fn: (req: AuthRequest, res: Response) => Promise<void>) {
  return (req: AuthRequest, res: Response, next: NextFunction) => fn(req, res).catch(next)
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas, tente novamente em 15 minutos' },
})

const RegisterSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
})

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

router.post('/register', authLimiter, wrap(async (req: Request, res: Response) => {
  const parsed = RegisterSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }

  const { name, email, password } = parsed.data
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) { res.status(409).json({ error: 'Email already in use' }); return }

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  })
  const user = await prisma.user.create({ data: { name, email, passwordHash } })

  const access = signAccess({ userId: user.id, email: user.email })
  const refresh = signRefresh({ userId: user.id, email: user.email })
  await prisma.refreshToken.create({
    data: { id: uuid(), token: refresh, userId: user.id, expiresAt: new Date(Date.now() + 7 * 864e5) }
  })

  log.info({ userId: user.id }, 'user registered')
  res.status(201).json({ access, refresh, user: { id: user.id, name: user.name, email: user.email } })
}))

router.post('/login', authLimiter, wrap(async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }

  const { email, password } = parsed.data
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) { res.status(401).json({ error: 'Invalid credentials' }); return }

  const valid = await argon2.verify(user.passwordHash, password)
  if (!valid) { res.status(401).json({ error: 'Invalid credentials' }); return }

  const access = signAccess({ userId: user.id, email: user.email })
  const refresh = signRefresh({ userId: user.id, email: user.email })
  await prisma.refreshToken.create({
    data: { id: uuid(), token: refresh, userId: user.id, expiresAt: new Date(Date.now() + 7 * 864e5) }
  })

  log.info({ userId: user.id }, 'user logged in')
  res.json({ access, refresh, user: { id: user.id, name: user.name, email: user.email } })
}))

router.post('/refresh', authLimiter, wrap(async (req: Request, res: Response) => {
  const { refresh } = req.body
  if (!refresh) { res.status(400).json({ error: 'refresh token required' }); return }

  try {
    const payload = verifyRefresh(refresh)
    const stored = await prisma.refreshToken.findUnique({ where: { token: refresh } })
    if (!stored || stored.expiresAt < new Date()) {
      res.status(401).json({ error: 'Refresh token expired or revoked' }); return
    }
    // rotate
    await prisma.refreshToken.delete({ where: { token: refresh } })
    const newAccess = signAccess({ userId: payload.userId, email: payload.email })
    const newRefresh = signRefresh({ userId: payload.userId, email: payload.email })
    await prisma.refreshToken.create({
      data: { id: uuid(), token: newRefresh, userId: payload.userId, expiresAt: new Date(Date.now() + 7 * 864e5) }
    })
    res.json({ access: newAccess, refresh: newRefresh })
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' })
  }
}))

router.post('/logout', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { refresh } = req.body
  if (refresh) await prisma.refreshToken.deleteMany({ where: { token: refresh, userId: req.userId! } })
  res.json({ ok: true })
}))

router.get('/me', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { id: true, name: true, email: true } })
  res.json(user)
}))

// Cleanup expired refresh tokens periodically (every 6 hours)
setInterval(async () => {
  try {
    const { count } = await prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    })
    if (count > 0) log.info({ count }, 'expired refresh tokens cleaned')
  } catch (err) {
    log.error({ err }, 'refresh token cleanup failed')
  }
}, 6 * 60 * 60 * 1000)

export default router
