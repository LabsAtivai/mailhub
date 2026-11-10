import { randomUUID } from 'crypto'
import { prisma } from '../../lib/prisma'
import { redis } from '../../lib/redis'
import { scope } from '../../lib/logger'
import { generateWithInstructions } from '../ai/openaiClient'
import { AGENT_SYSTEM_INSTRUCTIONS, NO_REPLY_TOKEN, buildAgentPrompt, extractAttachFlag } from './prompt'
import { getAssetAttachment, getAssetMeta, PRESENTATION_KIND } from './assets'
import { sanitizeEmailBody, cleanupFinalEmail } from './sanitize'
import { messageUseCases } from '../messages/useCases'
import { searchKnowledge } from './knowledge'
import { isSuppressed, suppress } from './suppression'
import { parseRecipients } from './recipients'
import { isNoiseMessage } from '../messages/noiseFilter'
import { detectReferral, referralBlocked, findReferrer } from './referral'
import { REFERRAL_INTRO_INSTRUCTIONS, buildReferralIntroPrompt } from './referralPrompt'
import { appendPhoneReferral } from './sheets'
import { detectLanguage } from './language'
import { groundDraft } from './grounding'
import { isAutomatic, isSelf, isStale, looksLikeOptOut, threadKeyOf, unwrapForwarded, type SkipReason } from './filters'

const log = scope('autoReply')

const THREAD_WINDOW_MS = 24 * 60 * 60 * 1000
const COUNTED = ['sent', 'test_sent', 'shadow', 'referral_pending', 'referral_sending', 'referral_sent']

// O teto diário protege o que sai de verdade. Em live conta só envio real (e indicações em andamento);
// rascunhos de shadow e e-mails de teste feitos antes ou durante o dia não podem consumir o teto do live.
// Em shadow e test continua contando tudo, para limitar o volume de rascunhos e de e-mails de teste.
export function dailyLimitStatuses(mode: string): string[] {
  return mode === 'live' ? ['sent', 'referral_pending', 'referral_sending', 'referral_sent'] : COUNTED
}

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
    select: { folder: { select: { specialUse: true } }, textBody: true, htmlBody: true, subject: true, fromEmail: true },
  })
  if (!msg || msg.folder.specialUse !== '\\Inbox') return
  if (isNoiseMessage(msg)) return // ruído (WRM etc.): nem busca o corpo
  if (msg.textBody || msg.htmlBody) return onBodyReady(payload.accountId, payload.messageId)
  await redis.publish('mailhub:fetch:body', JSON.stringify({ messageId: payload.messageId }))
}

type AgentConfig = NonNullable<Awaited<ReturnType<typeof getConfig>>>

interface IncomingMessage {
  id: string
  date: Date
  subject: string | null
  fromEmail: string | null
  textBody: string | null
  htmlBody: string | null
  messageId: string | null
  folder: { account: { userId: string; emailAddress: string } }
}

export async function onBodyReady(accountId: string, messageId: string) {
  const cfg = await getConfig(accountId)
  if (!cfg) return
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true, date: true, subject: true, fromEmail: true, textBody: true, htmlBody: true, messageId: true,
      folder: { select: { specialUse: true, account: { select: { userId: true, emailAddress: true } } } },
    },
  })
  if (!msg || msg.folder.specialUse !== '\\Inbox') return
  await processMessage(accountId, cfg, msg)
}

// Simulação de lead (rota admin): roda o mesmo pipeline com uma mensagem sintética, sem tocar na caixa.
// Nunca roda em `live` (a resposta iria para um remetente fictício) e não grava descadastro
// (não polui a lista Do-Not-Email do cliente com endereço de teste).
export class SimulationError extends Error {}

export async function simulateIncoming(accountId: string, input: { fromEmail: string; subject: string; body: string }) {
  if (process.env.AUTOREPLY_ENABLED !== 'true') throw new SimulationError('AUTOREPLY_ENABLED não está true no backend')
  const cfg = await prisma.autoReplyConfig.findUnique({ where: { accountId } })
  if (!cfg || cfg.mode === 'off') throw new SimulationError('Caixa sem agente ativo (modo off ou sem configuração)')
  if (cfg.mode === 'live') throw new SimulationError('Simulação não é permitida em modo live: use shadow ou test')
  if (cfg.mode === 'test' && !cfg.testRecipient) throw new SimulationError('Modo test sem testRecipient')
  const account = await prisma.mailAccount.findUnique({ where: { id: accountId }, select: { userId: true, emailAddress: true } })
  if (!account) throw new SimulationError('Conta não encontrada')

  const id = `sim-${randomUUID()}`
  await processMessage(accountId, cfg, {
    id, date: new Date(), subject: input.subject, fromEmail: input.fromEmail, textBody: input.body, htmlBody: null,
    messageId: null, folder: { account },
  }, { simulated: true })
  const result = await prisma.autoReplyLog.findUnique({
    where: { messageId: id },
    select: {
      status: true, reason: true, draft: true, sentTo: true, attachment: true, fromEmail: true, threadKey: true,
      referredEmail: true, referredName: true, referredPhone: true,
    },
  })
  if (!result) throw new SimulationError('Mensagem descartada como ruído (warmup WRM, resposta automática ou noreply): nada foi registrado')
  return result
}

async function processMessage(accountId: string, cfg: AgentConfig, msg: IncomingMessage, opts: { simulated?: boolean } = {}) {
  const messageId = msg.id
  let fromEmail = (msg.fromEmail || '').toLowerCase()
  let subject = msg.subject || ''
  let body = msg.textBody || (msg.htmlBody ? stripHtml(msg.htmlBody) : '')
  const unwrapped = unwrapForwarded(body)
  if (unwrapped) ({ fromEmail, subject, body } = unwrapped)
  const threadKey = threadKeyOf(subject)

  // Ruído conhecido (warmup "(WRM)", resposta automática, noreply, bounce): descarta em
  // silêncio, antes de qualquer registro. Não é classificado nem respondido e não aparece
  // para os usuários, igual à listagem de e-mails.
  if (isNoiseMessage({ subject: msg.subject, fromEmail: msg.fromEmail }) || isNoiseMessage({ subject, fromEmail })) return

  // Claim: o unique em messageId impede resposta dupla (mail:new e bodyReady
  // podem chegar os dois pra mesma mensagem).
  try {
    await prisma.autoReplyLog.create({
      data: { accountId, messageId, fromEmail, threadKey, status: 'processing' },
    })
  } catch {
    return
  }
  const finish = async (status: string, extra: {
    reason?: string; draft?: string; sentTo?: string; attachment?: string
    referredEmail?: string; referredName?: string; referredPhone?: string; subject?: string; inReplyTo?: string
  } = {}) => {
    await prisma.autoReplyLog.update({ where: { messageId }, data: { status, ...extra } })
  }

  let skip: SkipReason | null = null
  if (isSelf(msg.fromEmail || '', msg.folder.account.emailAddress)) skip = unwrapped ? null : 'self'
  // Frescor só vale para mensagem real; reenvio de teste (unwrapped) usa data de agora.
  if (!skip && !unwrapped && isStale(msg.date)) skip = 'stale'
  skip = skip ?? isAutomatic(fromEmail, subject) ?? (!body.trim() ? 'empty' : null)
  if (skip) return finish('skipped', { reason: skip })

  // Descadastro vale para o cliente inteiro (todas as caixas que compartilham o conteúdo).
  const clientKey = cfg.knowledgeAccountId ?? accountId
  if (await isSuppressed(clientKey, fromEmail)) return finish('skipped', { reason: 'suppressed' })
  if (!opts.simulated && looksLikeOptOut(body)) await suppress(clientKey, fromEmail, 'opt_out')

  const since = new Date(Date.now() - THREAD_WINDOW_MS)
  const recent = await prisma.autoReplyLog.count({
    where: { accountId, fromEmail, threadKey, createdAt: { gte: since }, status: { in: COUNTED } },
  })
  if (recent > 0) return finish('skipped', { reason: 'thread_recent' })

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const today = await prisma.autoReplyLog.count({
    where: { accountId, createdAt: { gte: startOfDay }, status: { in: dailyLimitStatuses(cfg.mode) } },
  })
  if (today >= cfg.dailyLimit) return finish('skipped', { reason: 'daily_limit' })

  try {
    const knowledge = await searchKnowledge(cfg.knowledgeAccountId ?? accountId, `${subject}\n\n${body}`.slice(0, 4000))
    // Indicação: o remetente passou o contato de outra pessoa. Com e-mail, gera o rascunho de continuidade
    // ao indicado (com o remetente em cópia); só com telefone, a resposta agradece e o contato vai para a planilha.
    const optOut = looksLikeOptOut(body)
    const referral = optOut ? null : await detectReferral({ subject, body, fromEmail, accountEmail: msg.folder.account.emailAddress })
    const referralBlock = referral?.email ? await referralBlocked(clientKey, accountId, referral.email) : null
    const emailReferral = referral?.email && !referralBlock ? referral : null
    const phoneReferral = !emailReferral && referral?.phone ? referral : null
    const referrer = await findReferrer(accountId, fromEmail)
    // Idioma detectado em código e passado explícito no pedido: o modelo, sozinho, volta ao português.
    const language = detectLanguage(`${subject}\n${body}`)

    const clientContext = [
      `Empresa representada: ${cfg.clientName || 'o cliente'}.`,
      optOut ? 'ATENÇÃO: o remetente parece pedir remoção da lista — siga a regra de PEDIDO DE REMOÇÃO.' : '',
      phoneReferral ? `INDICAÇÃO RECEBIDA: o remetente passou o telefone${phoneReferral.name ? ` de ${phoneReferral.name}` : ''} (${phoneReferral.phone}). Agradeça a indicação, diga que vamos entrar em contato com essa pessoa e não peça mais dados nem proponha reunião com o remetente.` : '',
      referral?.email && referralBlock === 'recent' ? 'INDICAÇÃO RECEBIDA: essa pessoa indicada já foi contatada por nós recentemente. Agradeça a indicação e diga que a conversa segue com ela. Não peça o contato de novo, não prometa um novo contato e não faça pitch comercial ao remetente.' : '',
      referral?.email && referralBlock === 'suppressed' ? 'INDICAÇÃO RECEBIDA: a pessoa indicada não pode ser abordada. Apenas agradeça a indicação, em uma ou duas frases, sem prometer contato com ela e sem citar o motivo.' : '',
      referrer ? `CONTINUIDADE: o remetente foi indicado por ${referrer.fromEmail}${referrer.subject ? ` (assunto "${referrer.subject}")` : ''} e já recebeu nosso e-mail de apresentação. Continue a conversa citando a indicação de forma natural, sem se reapresentar do zero.` : '',
      '',
      knowledge.length ? knowledge.join('\n\n---\n\n') : '[base de conhecimento vazia para este cliente]',
    ].filter(Boolean).join('\n')

    if (emailReferral?.email) {
      const rawIntro = cleanupFinalEmail(await generateWithInstructions(
        REFERRAL_INTRO_INSTRUCTIONS,
        buildReferralIntroPrompt({
          subject, body: sanitizeEmailBody(body, 12000) || body.slice(0, 12000), signature: cfg.signature, clientContext,
          senderEmail: fromEmail, senderName: emailReferral.senderName, referredName: emailReferral.name, referredEmail: emailReferral.email, language,
        }),
      ))
      if (!rawIntro.trim() || rawIntro.includes(NO_REPLY_TOKEN)) return finish('skipped', { reason: 'no_reply_needed' })
      // Mesma verificação de fatos da resposta normal. Aqui um humano aprova antes de sair, então só sinaliza.
      const gi = await groundDraft({ context: clientContext, received: `${subject}\n\n${sanitizeEmailBody(body, 4000) || body.slice(0, 4000)}`, draft: rawIntro })
      const intro = gi.draft
      const introFlag = gi.unsupported.length ? 'unsupported_claims' : (!gi.checked ? 'verification_failed' : undefined)
      const refFields = { referredEmail: emailReferral.email, referredName: emailReferral.name ?? undefined, subject, inReplyTo: msg.messageId ?? undefined }
      if (cfg.mode === 'shadow') return finish('shadow', { draft: intro, reason: introFlag ? `referral:${introFlag}` : 'referral', ...refFields })
      // Decisão do cliente: o e-mail ao indicado é primeiro contato, então em live só sai depois de aprovação humana.
      if (cfg.mode === 'live') return finish('referral_pending', { draft: intro, reason: introFlag, ...refFields })

      const testTo = parseRecipients(cfg.testRecipient)
      if (!testTo.length) return finish('error', { reason: 'testRecipient ausente', draft: intro })
      const testText = [
        `[TESTE] Indicação detectada. Depois de aprovado, este e-mail seria enviado para: ${emailReferral.email}`,
        `Com cópia para quem indicou: ${fromEmail}`,
        `Assunto: ${/^re:/i.test(subject) ? subject : `Re: ${subject}`}`,
        '',
        '===== E-MAIL RECEBIDO =====',
        `De: ${fromEmail}`,
        `Assunto: ${subject}`,
        '',
        sanitizeEmailBody(body, 3000) || body.slice(0, 3000),
        '',
        '===== E-MAIL AO INDICADO (rascunho) =====',
        '',
        intro,
      ].join('\n')
      await messageUseCases.send(msg.folder.account.userId, {
        accountId, to: testTo, subject: `[TESTE] Indicação: Re: ${subject}`,
        text: testText, html: `<div style="white-space:pre-wrap">${escapeHtml(testText)}</div>`,
      })
      return finish('test_sent', { draft: intro, sentTo: testTo.join(', '), reason: introFlag ? `referral:${introFlag}` : 'referral', ...refFields })
    }

    const presentation = await getAssetMeta(cfg.knowledgeAccountId ?? accountId, PRESENTATION_KIND)
    const raw = await generateWithInstructions(
      AGENT_SYSTEM_INSTRUCTIONS,
      buildAgentPrompt({ subject, body: sanitizeEmailBody(body, 12000) || body.slice(0, 12000), signature: cfg.signature, clientContext, attachmentName: presentation?.filename, language }),
    )
    const flagged = extractAttachFlag(raw)
    let draft = cleanupFinalEmail(flagged.text)
    const attachment = presentation && flagged.attach ? await getAssetAttachment(cfg.knowledgeAccountId ?? accountId, PRESENTATION_KIND) : null
    if (draft.includes(NO_REPLY_TOKEN)) return finish('skipped', { reason: 'no_reply_needed' })

    // Verificação de fatos: o que não está no material do cliente sai do rascunho. Pedido de remoção não tem
    // afirmação sobre a empresa, então não passa por aqui. Se algo sem base sobrar (ou a verificação falhar),
    // em live a resposta NÃO é enviada: fica registrada como pulada, com o rascunho, para revisão.
    let groundFlag: string | undefined
    let groundNote: string | undefined // rastro quando a verificação reescreveu o rascunho com sucesso
    if (!optOut) {
      const g = await groundDraft({ context: clientContext, received: `${subject}\n\n${sanitizeEmailBody(body, 4000) || body.slice(0, 4000)}`, draft })
      draft = g.draft
      if (g.unsupported.length) groundFlag = 'unsupported_claims'
      else if (!g.checked) groundFlag = 'verification_failed'
      else if (g.rewritten) groundNote = 'grounded_rewrite'
    }
    if (groundFlag && cfg.mode === 'live') return finish('skipped', { reason: groundFlag, draft })

    const phoneFields = phoneReferral ? { referredPhone: phoneReferral.phone ?? undefined, referredName: phoneReferral.name ?? undefined } : {}
    if (cfg.mode === 'shadow') return finish('shadow', { draft, reason: groundFlag ?? groundNote, attachment: attachment?.filename, ...phoneFields })

    const live = cfg.mode === 'live'
    const recipients = live ? [fromEmail] : parseRecipients(cfg.testRecipient)
    if (!recipients.length) return finish('error', { reason: 'testRecipient ausente', draft })
    const to = recipients.join(', ')

    const text = live
      ? draft
      : [
        `[TESTE] Esta resposta seria enviada para: ${fromEmail}`,
        ...(phoneReferral ? [`[PLANILHA] Seria registrado: ${phoneReferral.name || '(sem nome)'} | ${phoneReferral.phone} | indicado por ${fromEmail}`] : []),
        '',
        '===== E-MAIL RECEBIDO =====',
        `De: ${fromEmail}`,
        `Assunto: ${subject}`,
        '',
        sanitizeEmailBody(body, 3000) || body.slice(0, 3000),
        '',
        '===== RESPOSTA DO AGENTE =====',
        '',
        draft,
      ].join('\n')
    await messageUseCases.send(msg.folder.account.userId, {
      accountId,
      to: recipients,
      subject: live ? (/^re:/i.test(subject) ? subject : `Re: ${subject}`) : `[TESTE] Re: ${subject}`,
      text,
      html: `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`,
      inReplyTo: live ? (msg.messageId ?? undefined) : undefined,
      attachments: attachment ? [attachment] : undefined,
    })
    await finish(live ? 'sent' : 'test_sent', { draft, reason: groundFlag ?? groundNote, sentTo: to, attachment: attachment?.filename, ...phoneFields })
    log.info({ accountId, messageId, mode: cfg.mode }, 'auto reply sent')
    // Telefone indicado sem e-mail: a equipe liga. Só em live (em teste o endereço é fictício) e nunca derruba a resposta.
    if (live && phoneReferral?.phone) {
      await appendPhoneReferral({
        date: new Date(), client: cfg.clientName || '', mailbox: msg.folder.account.emailAddress, referrer: fromEmail,
        subject, name: phoneReferral.name || '', phone: phoneReferral.phone, mode: 'live',
      })
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.error({ accountId, messageId, reason }, 'auto reply failed')
    await finish('error', { reason: reason.slice(0, 300) })
  }
}
