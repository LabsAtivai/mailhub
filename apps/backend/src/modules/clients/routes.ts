import { Router, Response } from 'express'
import { requireAuth, AuthRequest } from '../../middleware/auth'
import { clientUseCases as uc, NotFoundError } from './useCases'
import { UpsertClientProfileSchema } from './dto'
import { scope } from '../../lib/logger'

const log = scope('clients')
const router = Router()
router.use(requireAuth)

function handle(res: Response, err: unknown) {
  if (err instanceof NotFoundError) { res.status(404).json({ error: err.message }); return }
  log.error({ err }, 'unhandled error in clients module')
  res.status(500).json({ error: 'Internal server error' })
}

// GET /accounts/:accountId/clients
router.get('/accounts/:accountId/clients', async (req: AuthRequest, res: Response) => {
  try {
    res.json(await uc.list(req.params.accountId, req.userId!))
  } catch (err) { handle(res, err) }
})

// PUT /accounts/:accountId/clients — upsert por domínio
router.put('/accounts/:accountId/clients', async (req: AuthRequest, res: Response) => {
  const parsed = UpsertClientProfileSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  try {
    res.json(await uc.upsert(req.params.accountId, req.userId!, parsed.data))
  } catch (err) { handle(res, err) }
})

// DELETE /accounts/:accountId/clients/:id
router.delete('/accounts/:accountId/clients/:id', async (req: AuthRequest, res: Response) => {
  try {
    await uc.remove(req.params.accountId, req.userId!, req.params.id)
    res.json({ ok: true })
  } catch (err) { handle(res, err) }
})

export default router
