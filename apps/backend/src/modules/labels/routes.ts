import { Router, Response } from 'express'
import { requireAuth, AuthRequest } from '../../middleware/auth'
import { labelUseCases as uc, ConflictError } from './useCases'
import { NotFoundError } from '../messages/useCases'
import { CreateLabelSchema, UpdateLabelSchema } from './dto'
import { scope } from '../../lib/logger'

const log = scope('labels')
const router = Router()
router.use(requireAuth)

function handle(res: Response, err: unknown) {
  if (err instanceof NotFoundError) { res.status(404).json({ error: err.message }); return }
  if (err instanceof ConflictError) { res.status(409).json({ error: err.message }); return }
  log.error({ err }, 'unhandled error in labels module')
  res.status(500).json({ error: 'Internal server error' })
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try { res.json(await uc.list(req.userId!)) } catch (err) { handle(res, err) }
})

router.post('/', async (req: AuthRequest, res: Response) => {
  const parsed = CreateLabelSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  try { res.status(201).json(await uc.create(req.userId!, parsed.data.name, parsed.data.color)) }
  catch (err) { handle(res, err) }
})

router.patch('/:id', async (req: AuthRequest, res: Response) => {
  const parsed = UpdateLabelSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  try { res.json(await uc.update(req.params.id, req.userId!, parsed.data)) }
  catch (err) { handle(res, err) }
})

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try { await uc.remove(req.params.id, req.userId!); res.json({ ok: true }) }
  catch (err) { handle(res, err) }
})

router.get('/:id/messages', async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100)
    res.json(await uc.messages(req.params.id, req.userId!, limit, req.query.cursor as string | undefined))
  } catch (err) { handle(res, err) }
})

export default router
