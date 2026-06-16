import { Router, Response } from 'express'
import { prisma } from '../../lib/prisma'
import { requireAuth, AuthRequest } from '../../middleware/auth'

const router = Router()
router.use(requireAuth)

// GET /accounts/:accountId/folders
router.get('/:accountId/folders', async (req: AuthRequest, res: Response) => {
  const account = await prisma.mailAccount.findFirst({
    where: { id: req.params.accountId, userId: req.userId! }
  })
  if (!account) { res.status(404).json({ error: 'Not found' }); return }

  const folders = await prisma.folder.findMany({
    where: { accountId: account.id },
    orderBy: { path: 'asc' },
    select: { id: true, path: true, name: true, specialUse: true, unreadCount: true, totalMessages: true }
  })
  res.json(folders)
})

export default router
