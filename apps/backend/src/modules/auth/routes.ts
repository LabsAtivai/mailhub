import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { signAccess, signRefresh, verifyRefresh } from '../../lib/jwt'
import { requireAuth, AuthRequest } from '../../middleware/auth'
import { v4 as uuid } from 'uuid'

const router = Router()

const RegisterSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
})

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

router.post('/register', async (req: Request, res: Response) => {
  const parsed = RegisterSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }

  const { name, email, password } = parsed.data
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) { res.status(409).json({ error: 'Email already in use' }); return }

  const passwordHash = await bcrypt.hash(password, 12)
  const user = await prisma.user.create({ data: { name, email, passwordHash } })

  const access = signAccess({ userId: user.id, email: user.email })
  const refresh = signRefresh({ userId: user.id, email: user.email })
  await prisma.refreshToken.create({
    data: { id: uuid(), token: refresh, userId: user.id, expiresAt: new Date(Date.now() + 7 * 864e5) }
  })

  res.status(201).json({ access, refresh, user: { id: user.id, name: user.name, email: user.email } })
})

router.post('/login', async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }

  const { email, password } = parsed.data
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) { res.status(401).json({ error: 'Invalid credentials' }); return }

  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) { res.status(401).json({ error: 'Invalid credentials' }); return }

  const access = signAccess({ userId: user.id, email: user.email })
  const refresh = signRefresh({ userId: user.id, email: user.email })
  await prisma.refreshToken.create({
    data: { id: uuid(), token: refresh, userId: user.id, expiresAt: new Date(Date.now() + 7 * 864e5) }
  })

  res.json({ access, refresh, user: { id: user.id, name: user.name, email: user.email } })
})

router.post('/refresh', async (req: Request, res: Response) => {
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
})

router.post('/logout', requireAuth, async (req: AuthRequest, res: Response) => {
  const { refresh } = req.body
  if (refresh) await prisma.refreshToken.deleteMany({ where: { token: refresh } })
  res.json({ ok: true })
})

router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { id: true, name: true, email: true } })
  res.json(user)
})

export default router
