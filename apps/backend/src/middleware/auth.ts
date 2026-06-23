import { Request, Response, NextFunction } from 'express'
import { verifyAccess } from '../lib/jwt'
import { prisma } from '../lib/prisma'

export interface AuthRequest extends Request {
  userId?: string
  userEmail?: string
  userRole?: string
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  try {
    const payload = verifyAccess(header.slice(7))
    req.userId = payload.userId
    req.userEmail = payload.email
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  prisma.user.findUnique({ where: { id: req.userId! }, select: { role: true } })
    .then(user => {
      if (!user || user.role !== 'admin') {
        res.status(403).json({ error: 'Acesso restrito a administradores' })
        return
      }
      req.userRole = 'admin'
      next()
    })
    .catch(() => { res.status(500).json({ error: 'Internal server error' }) })
}
