import { Router, Response } from 'express'
import { requireAuth, AuthRequest } from '../../middleware/auth'
import { aiUseCases as uc, NotFoundError, ValidationError } from './useCases'
import { OpenAiError } from './openaiClient'
import { GenerateReplySchema } from './dto'
import { scope } from '../../lib/logger'

const log = scope('ai')
const router = Router()
router.use(requireAuth)

function handle(res: Response, err: unknown) {
  if (err instanceof NotFoundError) { res.status(404).json({ error: err.message }); return }
  if (err instanceof ValidationError) { res.status(400).json({ error: err.message }); return }
  if (err instanceof OpenAiError) { res.status(502).json({ error: err.message }); return }
  log.error({ err }, 'unhandled error in ai module')
  res.status(500).json({ error: 'Internal server error' })
}

// POST /messages/:id/ai-reply — gera rascunho de resposta com base no
// histórico de respostas anteriores semelhantes (RAG sobre a pasta Sent).
router.post('/messages/:id/ai-reply', async (req: AuthRequest, res: Response) => {
  const parsed = GenerateReplySchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  try {
    res.json(await uc.generateReply(req.params.id, req.userId!, parsed.data))
  } catch (err) { handle(res, err) }
})

// POST /accounts/:accountId/ai-index — embeda mensagens da pasta Sent ainda
// não indexadas. Síncrono, pra teste local; em produção isso deveria virar
// um job assíncrono (worker), não rodar dentro do request da API.
router.post('/accounts/:accountId/ai-index', async (req: AuthRequest, res: Response) => {
  try {
    res.json(await uc.indexSentFolder(req.params.accountId, req.userId!))
  } catch (err) { handle(res, err) }
})

// POST /accounts/:accountId/clients/:clientProfileId/backfill — indexa (ou
// enfileira busca de corpo) só do histórico de Sent endereçado ao domínio
// desse cliente específico. Uso: pilotar com um cliente configurado antes de
// rodar em cima da caixa inteira.
router.post('/accounts/:accountId/clients/:clientProfileId/backfill', async (req: AuthRequest, res: Response) => {
  try {
    res.json(await uc.backfillClientDomain(req.params.accountId, req.userId!, req.params.clientProfileId))
  } catch (err) { handle(res, err) }
})

export default router
