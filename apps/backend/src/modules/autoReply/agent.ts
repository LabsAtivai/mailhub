import { prisma } from '../../lib/prisma'
import { redis } from '../../lib/redis'
import { scope } from '../../lib/logger'
import { generateWithInstructions } from '../ai/openaiClient'
import { AGENT_SYSTEM_INSTRUCTIONS, NO_REPLY_TOKEN, buildAgentPrompt, extractAttachFlag } from './prompt'
import { getAssetAttachment, getAssetMeta, PRESENTATION_KIND } from './assets'
import { sanitizeEmailBody, cleanupFinalEmail } from './sanitize'
import { messageUseCases } from '../messages/useCases'
import { searchKnowledge } from './knowledge'
import { isAutomatic, isSelf, looksLikeOptOut, threadKeyOf, unwrapForwarded, type SkipReason } from './filters'

const log = scope('autoReply')

const THREAD_WINDOW_MS = 24 * 60 * 60 * 1000
const COUNTED = ['sent', 'test_sent', 'shadow']

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function getConfig(accountId: string) {
  if (process.env.AUTOREPLY_ENABLED !== 'true') return null // kill switch global
  const cfg = await prisma.autoReplyConfig.findUnique({ where: { accountId } })
  return cfg && cfg.mode !== 'off' ? cfg : null
}

// mail:new só pede o corpo (AP-007: corpo é lazy); o processamento acontece em
// mail:bodyReady. Se o corpo já estiver no banco, processa direto.
export async function onNewMessage(payload: { accountId: string; messageId: string; selfSent?: boolean }) {
  if (payload.selfSent) return
  if (!(await getConfig(payload.accountId))) return
  const msg = await prisma.message.findUnique({
    where: { id: payload.messageId },
    select: { folder: { select: { specialUse: true } }, textBody: true, htmlBody: true },
  })
  if (!msg || msg.folder.specialUse !== '\\Inbox') return
  if (msg.textBody || msg.htmlBody) return onBodyReady(payload.accountId, payload.messageId)
  await redis.publish('mailhub:fetch:body', JSON.stringify({ messageId: payload.messageId }))
}

export async function onBodyReady(accountId: string, messageId: string) {
  const cfg = await getConfig(accountId)
  if (!cfg) return
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true, subject: true, fromEmail: true, textBody: true, htmlBody: true, messageId: true,
      folder: { select: { specialUse: true, account: { select: { userId: true, emailAddress: true } } } },
    },
  })
  if (!msg || msg.folder.specialUse !== '\\Inbox') return

  let fromEmail = (msg.fromEmail || '').toLowerCase()
  let subject = msg.subject || ''
  let body = msg.textBody || (msg.htmlBody ? stripHtml(msg.htmlBody) : '')
  const unwrapped = unwrapForwarded(body)
  if (unwrapped) ({ fromEmail, subject, body } = unwrapped)
  const threadKey = threadKeyOf(subject)

  // Claim: o unique em messageId impede resposta dupla (mail:new e bodyReady
  // podem chegar os dois pra mesma mensagem).
  try {
    await prisma.autoReplyLog.create({
      data: { accountId, messageId, fromEmail, threadKey, status: 'processing' },
    })
  } catch {
    return
  }
  const finish = async (status: string, extra: { reason?: string; draft?: string; sentTo?: string; attachment?: string } = {}) => {
    await prisma.autoReplyLog.update({ where: { messageId }, data: { status, ...extra } })
  }

  let skip: SkipReason | null = null
  if (isSelf(msg.fromEmail || '', msg.folder.account.emailAddress)) skip = unwrapped ? null : 'self'
  skip = skip ?? isAutomatic(fromEmail, subject) ?? (!body.trim() ? 'empty' : null)
  if (skip) return finish('skipped', { reason: skip })

  const since = new Date(Date.now() - THREAD_WINDOW_MS)
  const recent = await prisma.autoReplyLog.count({
    where: { accountId, fromEmail, threadKey, createdAt: { gte: since }, status: { in: COUNTED } },
  })
  if (recent > 0) return finish('skipped', { reason: 'thread_recent' })

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const today = await prisma.autoReplyLog.count({
    where: { accountId, createdAt: { gte: startOfDay }, status: { in: COUNTED } },
  })
  if (today >= cfg.dailyLimit) return finish('skipped', { reason: 'daily_limit' })

  try {
    const knowledge = await searchKnowledge(accountId, `${subject}\n\n${body}`.slice(0, 4000))
    const clientContext = [
      `Empresa representada: ${cfg.clientName || 'o cliente'}.`,
      looksLikeOptOut(body) ? 'ATENÇÃO: o remetente parece pedir remoção da lista — siga a regra de PEDIDO DE REMOÇÃO.' : '',
      '',
      knowledge.length ? knowledge.join('\n\n---\n\n') : '[base de conhecimento vazia para este cliente]',
    ].filter(Boolean).join('\n')

    const presentation = await getAssetMeta(accountId, PRESENTATION_KIND)
    const raw = await generateWithInstructions(
      AGENT_SYSTEM_INSTRUCTIONS,
      buildAgentPrompt({ subject, body: sanitizeEmailBody(body, 12000) || body.slice(0, 12000), signature: cfg.signature, clientContext, attachmentName: presentation?.filename }),
    )
    const flagged = extractAttachFlag(raw)
    const draft = cleanupFinalEmail(flagged.text)
    const attachment = presentation && flagged.attach ? await getAssetAttachment(accountId, PRESENTATION_KIND) : null
    if (draft.includes(NO_REPLY_TOKEN)) return finish('skipped', { reason: 'no_reply_needed' })
    if (cfg.mode === 'shadow') return finish('shadow', { draft, attachment: attachment?.filename })

    const live = cfg.mode === 'live'
    const to = live ? fromEmail : cfg.testRecipient
    if (!to) return finish('error', { reason: 'testRecipient ausente', draft })

    const text = live
      ? draft
      : `[TESTE] Esta resposta seria enviada para: ${fromEmail}\nAssunto original: ${subject}\n\n----------\n\n${draft}`
    await messageUseCases.send(msg.folder.account.userId, {
      accountId,
      to: [to],
      subject: live ? (/^re:/i.test(subject) ? subject : `Re: ${subject}`) : `[TESTE] Re: ${subject}`,
      text,
      html: `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`,
      inReplyTo: live ? (msg.messageId ?? undefined) : undefined,
      attachments: attachment ? [attachment] : undefined,
    })
    await finish(live ? 'sent' : 'test_sent', { draft, sentTo: to, attachment: attachment?.filename })
    log.info({ accountId, messageId, mode: cfg.mode }, 'auto reply sent')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.error({ accountId, messageId, reason }, 'auto reply failed')
    await finish('error', { reason: reason.slice(0, 300) })
  }
}
