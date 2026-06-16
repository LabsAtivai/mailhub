import { Router, Response } from 'express'
import { requireAuth, AuthRequest } from '../../middleware/auth'
import { messageUseCases as uc, NotFoundError, ForbiddenError } from './useCases'
import { SetFlagsSchema, MoveMessageSchema, SendMailSchema, AssignLabelSchema } from './dto'

const router = Router()
router.use(requireAuth)

// thin error adapter — maps domain errors to HTTP
function handle(res: Response, err: unknown) {
  if (err instanceof NotFoundError) { res.status(404).json({ error: err.message }); return }
  if (err instanceof ForbiddenError) { res.status(403).json({ error: err.message }); return }
  res.status(500).json({ error: (err as Error).message })
}

// GET /folders/:folderId/messages
router.get('/folders/:folderId/messages', async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100)
    const result = await uc.listFolder(req.params.folderId, req.userId!, limit, req.query.cursor as string | undefined)
    res.json(result)
  } catch (err) { handle(res, err) }
})

// GET /messages/search?q=
router.get('/messages/search', async (req: AuthRequest, res: Response) => {
  try {
    const items = await uc.search(req.userId!, (req.query.q as string) || '')
    res.json({ items })
  } catch (err) { handle(res, err) }
})

// GET /messages/:id
router.get('/messages/:id', async (req: AuthRequest, res: Response) => {
  try {
    res.json(await uc.getDetail(req.params.id, req.userId!))
  } catch (err) { handle(res, err) }
})

// PATCH /messages/:id
router.patch('/messages/:id', async (req: AuthRequest, res: Response) => {
  const parsed = SetFlagsSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  try {
    res.json(await uc.setFlags(req.params.id, req.userId!, parsed.data))
  } catch (err) { handle(res, err) }
})

// POST /messages/:id/move
router.post('/messages/:id/move', async (req: AuthRequest, res: Response) => {
  const parsed = MoveMessageSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  try {
    await uc.move(req.params.id, req.userId!, parsed.data.folderId)
    res.json({ ok: true })
  } catch (err) { handle(res, err) }
})

// DELETE /messages/:id → trash
router.delete('/messages/:id', async (req: AuthRequest, res: Response) => {
  try {
    await uc.remove(req.params.id, req.userId!)
    res.json({ ok: true })
  } catch (err) { handle(res, err) }
})

// POST /messages/send
router.post('/messages/send', async (req: AuthRequest, res: Response) => {
  const parsed = SendMailSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  try {
    res.json({ ok: true, ...(await uc.send(req.userId!, parsed.data)) })
  } catch (err) { handle(res, err) }
})

// POST /messages/:id/labels
router.post('/messages/:id/labels', async (req: AuthRequest, res: Response) => {
  const parsed = AssignLabelSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  try {
    res.json(await uc.assignLabel(req.params.id, req.userId!, parsed.data.labelId))
  } catch (err) { handle(res, err) }
})

// DELETE /messages/:id/labels/:labelId
router.delete('/messages/:id/labels/:labelId', async (req: AuthRequest, res: Response) => {
  try {
    res.json(await uc.removeLabel(req.params.id, req.userId!, req.params.labelId))
  } catch (err) { handle(res, err) }
})

// GET /attachments/:id/download
router.get('/attachments/:id/download', async (req: AuthRequest, res: Response) => {
  try {
    res.json(await uc.requestAttachment(req.params.id, req.userId!))
  } catch (err) { handle(res, err) }
})

export default router
