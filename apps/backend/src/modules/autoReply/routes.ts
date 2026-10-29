import { Router, Response } from 'express'
import { z } from 'zod'
import { requireAuth, requireAdmin, AuthRequest } from '../../middleware/auth'
import { prisma } from '../../lib/prisma'
import { scope } from '../../lib/logger'
import { OpenAiError } from '../ai/openaiClient'
import { getAutoReplyMetrics } from './metrics'
import { ingestDocument, knowledgeStats } from './knowledge'
import { checkReadiness } from './readiness'
import { listAssets, upsertAsset } from './assets'

const log = scope('autoReply')
const router = Router()
router.use(requireAuth)

const ConfigSchema = z.object({
  mode: z.enum(['off', 'shadow', 'test', 'live']),
  testRecipient: z.string().email().nullable().optional(),
  clientName: z.string().max(200).optional(),
  signature: z.string().max(2000).optional(),
  dailyLimit: z.number().int().min(1).max(500).optional(),
}).refine(v => v.mode !== 'test' || !!v.testRecipient, { message: 'testRecipient obrigatório no modo test' })

const DocumentSchema = z.object({
  source: z.string().min(1).max(200),
  text: z.string().min(1).max(500_000),
})

const AssetSchema = z.object({
  kind: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/),
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100).default('application/pdf'),
  contentBase64: z.string().min(1),
  driveFileId: z.string().max(200).nullable().optional(),
})

function fail(res: Response, err: unknown) {
  if (err instanceof OpenAiError) { res.status(502).json({ error: err.message }); return }
  log.error({ err }, 'unhandled error in autoReply module')
  res.status(500).json({ error: 'Internal server error' })
}

async function ownsAccount(userId: string, accountId: string) {
  return !!(await prisma.mailAccount.findFirst({ where: { id: accountId, userId }, select: { id: true } }))
}

// GET /accounts/:accountId/auto-reply/metrics?days=30 — painel "Métricas" da conta.
router.get('/accounts/:accountId/auto-reply/metrics', async (req: AuthRequest, res: Response) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '30'), 10) || 30, 1), 365)
  try {
    if (!(await ownsAccount(req.userId!, req.params.accountId))) { res.status(404).json({ error: 'Conta não encontrada' }); return }
    res.json(await getAutoReplyMetrics(req.params.accountId, days))
  } catch (err) { fail(res, err) }
})

// GET /accounts/:accountId/auto-reply/readiness — checklist de prontidão para produção.
router.get('/accounts/:accountId/auto-reply/readiness', async (req: AuthRequest, res: Response) => {
  try {
    if (!(await ownsAccount(req.userId!, req.params.accountId))) { res.status(404).json({ error: 'Conta não encontrada' }); return }
    res.json(await checkReadiness(req.params.accountId))
  } catch (err) { fail(res, err) }
})

// GET /admin/auto-reply/:accountId/readiness — mesma verificação, para qualquer conta.
router.get('/admin/auto-reply/:accountId/readiness', requireAdmin, async (req: AuthRequest, res: Response) => {
  try { res.json(await checkReadiness(req.params.accountId)) } catch (err) { fail(res, err) }
})

// PUT /admin/auto-reply/:accountId — liga/desliga e configura o agente da caixa.
router.put('/admin/auto-reply/:accountId', requireAdmin, async (req: AuthRequest, res: Response) => {
  const parsed = ConfigSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  try {
    const account = await prisma.mailAccount.findUnique({ where: { id: req.params.accountId }, select: { id: true } })
    if (!account) { res.status(404).json({ error: 'Conta não encontrada' }); return }
    // Modo live só liga depois de passar na verificação de prontidão (bloqueios).
    if (parsed.data.mode === 'live') {
      const readiness = await checkReadiness(account.id)
      if (!readiness.ok) { res.status(409).json({ error: 'Caixa não está pronta para o modo live', readiness }); return }
    }
    const data = { ...parsed.data, testRecipient: parsed.data.testRecipient ?? null }
    res.json(await prisma.autoReplyConfig.upsert({
      where: { accountId: account.id }, create: { accountId: account.id, ...data }, update: data,
    }))
  } catch (err) { fail(res, err) }
})

// POST /admin/auto-reply/:accountId/knowledge — ingestão idempotente por `source`.
router.post('/admin/auto-reply/:accountId/knowledge', requireAdmin, async (req: AuthRequest, res: Response) => {
  const parsed = DocumentSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  try {
    const account = await prisma.mailAccount.findUnique({ where: { id: req.params.accountId }, select: { id: true } })
    if (!account) { res.status(404).json({ error: 'Conta não encontrada' }); return }
    const chunks = await ingestDocument(account.id, parsed.data.source, parsed.data.text)
    res.json({ source: parsed.data.source, chunks })
  } catch (err) { fail(res, err) }
})

router.get('/admin/auto-reply/:accountId/knowledge', requireAdmin, async (req: AuthRequest, res: Response) => {
  try { res.json(await knowledgeStats(req.params.accountId)) } catch (err) { fail(res, err) }
})

// POST /admin/auto-reply/:accountId/assets — arquivo que o agente pode anexar (kind "presentation").
router.post('/admin/auto-reply/:accountId/assets', requireAdmin, async (req: AuthRequest, res: Response) => {
  const parsed = AssetSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  try {
    const account = await prisma.mailAccount.findUnique({ where: { id: req.params.accountId }, select: { id: true } })
    if (!account) { res.status(404).json({ error: 'Conta não encontrada' }); return }
    res.json(await upsertAsset(account.id, parsed.data))
  } catch (err) {
    if (err instanceof Error && /Arquivo/.test(err.message)) { res.status(400).json({ error: err.message }); return }
    fail(res, err)
  }
})

router.get('/admin/auto-reply/:accountId/assets', requireAdmin, async (req: AuthRequest, res: Response) => {
  try { res.json(await listAssets(req.params.accountId)) } catch (err) { fail(res, err) }
})

export default router
