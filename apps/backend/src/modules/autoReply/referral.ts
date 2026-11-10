import { prisma } from '../../lib/prisma'
import { scope } from '../../lib/logger'
import { generateWithInstructions } from '../ai/openaiClient'
import { messageUseCases } from '../messages/useCases'
import { isNoiseMessage } from '../messages/noiseFilter'
import { isSuppressed } from './suppression'
import { REFERRAL_EXTRACT_INSTRUCTIONS } from './referralPrompt'

const log = scope('autoReply')

export const REFERRAL_DEDUPE_MS = 30 * 24 * 60 * 60 * 1000
export const REFERRAL_STATUSES_THAT_COUNT = ['referral_pending', 'referral_sending', 'referral_sent', 'test_sent', 'shadow']

export interface Referral {
  email: string | null
  phone: string | null
  name: string | null
  senderName: string | null
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[a-z]{2,}$/i
const HINTS = [
  'indic', 'encaminh', 'fale com', 'falar com', 'procure', 'procurar', 'contato d', 'cuida', 'responsável', 'responsavel',
  'repass', 'passei', 'passar para', 'em cópia', 'em copia', 'cc:', 'copiei', 'colocando', 'refer', 'introduc', 'connect you', 'speak with', 'talk to',
]

// Filtro barato: só chama o modelo quando o texto sugere indicação.
export function mayContainReferral(body: string): boolean {
  const text = body.toLowerCase().slice(0, 4000)
  return HINTS.some(h => text.includes(h))
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, '')
}

function clean(s: unknown, max: number): string | null {
  if (typeof s !== 'string') return null
  const t = s.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

export function parseReferralJson(raw: string): Record<string, unknown> | null {
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(text.slice(start, end + 1))
    return v && typeof v === 'object' ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

// O modelo só sugere: e-mail e telefone precisam estar literalmente no texto, não podem ser do
// próprio remetente nem da própria caixa, e e-mail de ruído (noreply, bounce, warmup) é recusado.
export function validateReferral(
  raw: Record<string, unknown> | null,
  ctx: { body: string; fromEmail: string; accountEmail: string },
): Referral | null {
  if (!raw || raw.indicacao !== true) return null
  const body = ctx.body.toLowerCase()
  const from = ctx.fromEmail.trim().toLowerCase()
  const own = ctx.accountEmail.trim().toLowerCase()
  const ownDomain = own.split('@')[1]

  let email = clean(raw.email, 200)?.toLowerCase() ?? null
  if (email) {
    const ok = EMAIL_RE.test(email) && body.includes(email) && email !== from && email !== own
      && email.split('@')[1] !== ownDomain && !isNoiseMessage({ fromEmail: email })
    if (!ok) email = null
  }

  let phone = clean(raw.telefone, 40)
  if (phone) {
    const d = digitsOf(phone)
    const inBody = digitsOf(ctx.body).includes(d)
    if (d.length < 10 || d.length > 13 || !inBody) phone = null
  }

  if (!email && !phone) return null
  return { email, phone, name: clean(raw.nome, 80), senderName: clean(raw.remetente_nome, 80) }
}

// Falha do modelo nunca impede a resposta normal: sem indicação detectada, segue o fluxo comum.
export async function detectReferral(ctx: { subject: string; body: string; fromEmail: string; accountEmail: string }): Promise<Referral | null> {
  if (!mayContainReferral(ctx.body)) return null
  try {
    const raw = await generateWithInstructions(
      REFERRAL_EXTRACT_INSTRUCTIONS,
      `Remetente: ${ctx.fromEmail}\nAssunto: ${ctx.subject}\n\n${ctx.body.slice(0, 6000)}`,
      400,
    )
    return validateReferral(parseReferralJson(raw), ctx)
  } catch (err) {
    log.warn({ reason: err instanceof Error ? err.message : String(err) }, 'detecção de indicação falhou; segue fluxo normal')
    return null
  }
}

// O indicado não pode ser abordado se pediu descadastro (qualquer caixa do cliente) ou se já recebeu
// uma apresentação nesta caixa nos últimos 30 dias.
export async function referralBlocked(clientKey: string, accountId: string, email: string): Promise<'suppressed' | 'recent' | null> {
  if (await isSuppressed(clientKey, email)) return 'suppressed'
  const since = new Date(Date.now() - REFERRAL_DEDUPE_MS)
  const recent = await prisma.autoReplyLog.count({
    where: { accountId, referredEmail: email, createdAt: { gte: since }, status: { in: REFERRAL_STATUSES_THAT_COUNT } },
  })
  return recent > 0 ? 'recent' : null
}

// Quando o indicado responde, o agente precisa saber quem o indicou para dar continuidade.
export async function findReferrer(accountId: string, referredEmail: string): Promise<{ fromEmail: string; subject: string | null } | null> {
  const row = await prisma.autoReplyLog.findFirst({
    where: { accountId, referredEmail: referredEmail.toLowerCase(), status: 'referral_sent' },
    orderBy: { createdAt: 'desc' },
    select: { fromEmail: true, subject: true },
  })
  return row
}

export class ReferralError extends Error {}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function listReferrals(status: string = 'referral_pending') {
  return prisma.autoReplyLog.findMany({
    where: { status },
    orderBy: { createdAt: 'asc' },
    take: 200,
    select: {
      id: true, accountId: true, createdAt: true, status: true, fromEmail: true, subject: true,
      referredEmail: true, referredName: true, draft: true, reason: true,
      account: { select: { emailAddress: true } },
    },
  })
}

// Aprovação humana: só aqui o e-mail ao indicado sai de verdade. Reconfere kill switch, modo,
// descadastro e teto diário, e trava a linha para impedir envio duplo em cliques simultâneos.
export async function approveReferral(logId: string, editedDraft?: string) {
  if (process.env.AUTOREPLY_ENABLED !== 'true') throw new ReferralError('AUTOREPLY_ENABLED não está true no backend')
  const row = await prisma.autoReplyLog.findUnique({ where: { id: logId } })
  if (!row || row.status !== 'referral_pending') throw new ReferralError('Indicação não encontrada ou não está pendente')
  if (!row.referredEmail) throw new ReferralError('Indicação sem e-mail do indicado')
  const cfg = await prisma.autoReplyConfig.findUnique({ where: { accountId: row.accountId } })
  if (!cfg || cfg.mode !== 'live') throw new ReferralError('Caixa não está em modo live')
  const clientKey = cfg.knowledgeAccountId ?? row.accountId
  if (await isSuppressed(clientKey, row.referredEmail)) throw new ReferralError('O indicado está na lista de descadastro')
  if (await isSuppressed(clientKey, row.fromEmail)) throw new ReferralError('Quem indicou está na lista de descadastro')

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const today = await prisma.autoReplyLog.count({
    where: { accountId: row.accountId, createdAt: { gte: startOfDay }, status: { in: ['sent', 'test_sent', 'shadow', 'referral_sent'] } },
  })
  if (today >= cfg.dailyLimit) throw new ReferralError('Teto diário da caixa atingido')

  const draft = (editedDraft ?? row.draft ?? '').trim()
  if (!draft) throw new ReferralError('Rascunho vazio')
  const account = await prisma.mailAccount.findUnique({ where: { id: row.accountId }, select: { userId: true } })
  if (!account) throw new ReferralError('Conta não encontrada')

  const lock = await prisma.autoReplyLog.updateMany({ where: { id: logId, status: 'referral_pending' }, data: { status: 'referral_sending' } })
  if (lock.count !== 1) throw new ReferralError('Indicação já está sendo enviada')
  const subject = row.subject || ''
  try {
    await messageUseCases.send(account.userId, {
      accountId: row.accountId,
      to: [row.referredEmail],
      cc: [row.fromEmail],
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      text: draft,
      html: `<div style="white-space:pre-wrap">${escapeHtml(draft)}</div>`,
      inReplyTo: row.inReplyTo ?? undefined,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await prisma.autoReplyLog.update({ where: { id: logId }, data: { status: 'referral_pending', reason: reason.slice(0, 300) } })
    throw new ReferralError(`Falha no envio: ${reason}`)
  }
  return prisma.autoReplyLog.update({
    where: { id: logId },
    data: { status: 'referral_sent', draft, sentTo: `${row.referredEmail} (cc ${row.fromEmail})`, reason: null },
    select: { id: true, status: true, sentTo: true, referredEmail: true },
  })
}

export async function rejectReferral(logId: string) {
  const res = await prisma.autoReplyLog.updateMany({ where: { id: logId, status: 'referral_pending' }, data: { status: 'referral_rejected' } })
  if (res.count !== 1) throw new ReferralError('Indicação não encontrada ou não está pendente')
  return { id: logId, status: 'referral_rejected' }
}
