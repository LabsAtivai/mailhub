import { Router, Response } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { requireAuth, AuthRequest } from '../../middleware/auth'
import { prisma } from '../../lib/prisma'
import { scope } from '../../lib/logger'

const log = scope('negativacao')
const router = Router()
router.use(requireAuth)

// Painel de negativação (repo negativacaomailgun). Ele já espalha o valor pela
// Lista de e-mails a não enviar de TODAS as contas Snov.io ativas — aqui só
// repassamos o pedido, sem duplicar a lógica de Snov.io.
const PANEL_TIMEOUT_MS = 15000

const triggerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId || req.ip || 'unknown',
  message: { error: 'Muitas negativações em pouco tempo, aguarde alguns minutos' },
})

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

const TriggerSchema = z.object({
  value: z.string().trim().toLowerCase().min(3).max(254),
  accountId: z.string().uuid(),
})

function panelUrl(): string | null {
  const url = process.env.NEGATIVACAO_API_URL
  return url ? url.replace(/\/+$/, '') : null
}

async function callPanel(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const base = panelUrl()
  if (!base) return { status: 503, body: { error: 'NEGATIVACAO_API_URL não configurada' } }
  try {
    const res = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(PANEL_TIMEOUT_MS) })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  } catch (err) {
    log.error({ err: (err as Error).message, path }, 'painel de negativação indisponível')
    return { status: 502, body: { error: 'Painel de negativação indisponível' } }
  }
}

function send(res: Response, out: { status: number; body: unknown }) {
  // O painel (FastAPI) responde { detail }; normaliza pro formato { error } do MailHub.
  const b = out.body as { detail?: unknown; error?: unknown } | null
  if (out.status >= 400 && b && typeof b === 'object' && !('error' in b)) {
    res.status(out.status).json({ error: typeof b.detail === 'string' ? b.detail : 'Erro no painel de negativação' })
    return
  }
  res.status(out.status).json(out.body)
}

// POST /negativacao/runs — { value: "email@x.com" | "dominio.com" | "@dominio.com", accountId }
// A negativação vale só para a conta Snov.io dona da caixa (accountId). O painel acha a
// dona pelo e-mail igual ao da caixa ou pelo trecho do domínio da caixa (ex.: mktxpto)
// em qualquer campo da conta, sempre dentro da lista de contas permitidas.
router.post('/runs', triggerLimiter, async (req: AuthRequest, res: Response) => {
  const parsed = TriggerSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'Informe o e-mail/domínio e a caixa' }); return }

  const value = parsed.data.value.replace(/^@/, '')
  if (!EMAIL_RE.test(value) && !DOMAIN_RE.test(value)) {
    res.status(400).json({ error: 'Valor inválido: use email@dominio.com ou dominio.com' })
    return
  }

  // Ownership: a caixa precisa ser do usuário logado.
  const mailbox = await prisma.mailAccount.findFirst({
    where: { id: parsed.data.accountId, userId: req.userId! },
    select: { emailAddress: true },
  })
  if (!mailbox) { res.status(404).json({ error: 'Caixa não encontrada' }); return }
  const mailboxEmail = mailbox.emailAddress.trim().toLowerCase()

  log.info({ userId: req.userId, userEmail: req.userEmail, value, mailboxEmail }, 'negativação solicitada')
  send(res, await callPanel('/api/manual/runs/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, mailbox: mailboxEmail }),
  }))
})

// GET /negativacao/runs — histórico
router.get('/runs', async (_req: AuthRequest, res: Response) => {
  send(res, await callPanel('/api/manual/runs?limit=50'))
})

// GET /negativacao/runs/:id — detalhe por conta/lista
router.get('/runs/:id', async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: 'id inválido' }); return }
  send(res, await callPanel(`/api/manual/runs/${id}`))
})

export default router
