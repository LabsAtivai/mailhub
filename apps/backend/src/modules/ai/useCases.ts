import { messageRepository } from '../messages/repository'
import { clientRepository } from '../clients/repository'
import { aiRepository } from './repository'
import { embedText, generateReplyText, EMBEDDING_MODEL } from './openaiClient'
import { scope } from '../../lib/logger'
import { redis } from '../../lib/redis'
import type { GenerateReplyDto } from './dto'

const log = scope('ai')

export class NotFoundError extends Error {}
export class ValidationError extends Error {}

const MAX_REFERENCES = 5

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function domainOf(email: string): string {
  return email.split('@')[1]?.toLowerCase().trim() || ''
}

function firstRecipient(toJson: string): string {
  try {
    const list = JSON.parse(toJson)
    const first = Array.isArray(list) ? list[0] : null
    return first?.address || first?.email || first || ''
  } catch {
    return ''
  }
}

function buildReferenceBlock(items: Array<{ subject: string | null; textBody: string | null; toJson: string; distance: number }>): string {
  return items
    .map((item, i) => {
      const to = firstRecipient(item.toJson)
      const similarity = (1 - item.distance).toFixed(2)
      const body = (item.textBody || '').slice(0, 3000)
      return `--- Resposta anterior ${i + 1} (similaridade ${similarity}${to ? `, para ${to}` : ''}) ---\nAssunto: ${item.subject || '[sem assunto]'}\n\n${body}`
    })
    .join('\n\n')
}

export const aiUseCases = {
  async generateReply(messageId: string, userId: string, dto: GenerateReplyDto) {
    const msg = await messageRepository.findMessageWithOwner(messageId)
    if (!msg || msg.folder.account.userId !== userId) throw new NotFoundError('Mensagem não encontrada')

    const subject = msg.subject || ''
    const body = msg.textBody || (msg.htmlBody ? stripHtml(msg.htmlBody) : '')
    if (!subject && !body) throw new ValidationError('Mensagem sem conteúdo pra gerar resposta')

    const accountId = msg.folder.account.id
    const queryEmbedding = await embedText(`${subject}\n\n${body}`.trim())
    const similar = await aiRepository.findSimilarSentMessages(accountId, queryEmbedding, msg.id, MAX_REFERENCES)

    const clientProfile = msg.fromEmail
      ? await clientRepository.findByDomain(accountId, domainOf(msg.fromEmail))
      : null

    log.info({
      messageId, accountId, referencesFound: similar.length, clientProfileFound: !!clientProfile,
    }, 'ai reply: context assembled')

    const response = await generateReplyText({
      subject,
      body,
      signature: dto.signature || '',
      referenceBlock: buildReferenceBlock(similar),
      clientContext: clientProfile ? `Cliente: ${clientProfile.clientName}\n\n${clientProfile.content}` : '',
    })

    return {
      response,
      clientProfileUsed: clientProfile ? { id: clientProfile.id, clientName: clientProfile.clientName } : null,
      usedReferences: similar.map(s => ({
        id: s.id,
        subject: s.subject,
        similarity: Number((1 - s.distance).toFixed(3)),
      })),
    }
  },

  async indexSentFolder(accountId: string, userId: string) {
    const account = await messageRepository.findAccountForUser(accountId, userId)
    if (!account) throw new NotFoundError('Conta não encontrada')

    const pending = await aiRepository.findSentMessagesPendingEmbedding(accountId)
    let indexed = 0
    for (const m of pending) {
      const text = `${m.subject || ''}\n\n${m.textBody || ''}`.trim()
      if (!text) continue
      const embedding = await embedText(text)
      await aiRepository.upsertEmbedding(m.id, embedding, EMBEDDING_MODEL)
      indexed++
    }

    log.info({ accountId, candidates: pending.length, indexed }, 'ai: sent folder indexed')
    return { candidates: pending.length, indexed }
  },

  // Backfill escopado a UM cliente já configurado (por domínio) — não varre a
  // caixa inteira. Pra quem já tem corpo buscado, embeda na hora; pra quem
  // ainda não tem (histórico antigo, nunca aberto), só pede a busca do corpo
  // — o auto-index (indexMessageIfSent) cuida de embedar assim que o worker
  // responder com mail:bodyReady, sem precisar rodar de novo.
  async backfillClientDomain(accountId: string, userId: string, clientProfileId: string) {
    const account = await messageRepository.findAccountForUser(accountId, userId)
    if (!account) throw new NotFoundError('Conta não encontrada')

    const profile = await clientRepository.findByIdForAccount(clientProfileId, accountId)
    if (!profile) throw new NotFoundError('Perfil de cliente não encontrado')

    const candidates = await aiRepository.findSentMessagesForDomain(accountId, profile.domain)
    let embeddedNow = 0
    let queuedForBody = 0
    for (const m of candidates) {
      if (m.hasEmbedding) continue
      if (m.textBody) {
        const text = `${m.subject || ''}\n\n${m.textBody}`.trim()
        if (!text) continue
        const embedding = await embedText(text)
        await aiRepository.upsertEmbedding(m.id, embedding, EMBEDDING_MODEL)
        embeddedNow++
      } else {
        await redis.publish('mailhub:fetch:body', JSON.stringify({ messageId: m.id }))
        queuedForBody++
      }
    }

    log.info({
      accountId, domain: profile.domain, candidates: candidates.length, embeddedNow, queuedForBody,
    }, 'ai: client domain backfill triggered')
    return { candidates: candidates.length, embeddedNow, queuedForBody }
  },

  // Gatilho automático: chamado pelo relay Redis→Socket.IO quando um corpo de
  // mensagem termina de ser buscado (mail:bodyReady). Se for uma mensagem da
  // pasta Sent, embeda na hora — assim a pasta Sent fica indexada sozinha à
  // medida que o usuário manda e-mails, sem precisar rodar /ai-index manual.
  async indexMessageIfSent(messageId: string) {
    const msg = await messageRepository.findMessageWithOwner(messageId)
    if (!msg || msg.folder.specialUse !== '\\Sent' || !msg.textBody) return

    const text = `${msg.subject || ''}\n\n${msg.textBody}`.trim()
    if (!text) return

    const embedding = await embedText(text)
    await aiRepository.upsertEmbedding(msg.id, embedding, EMBEDDING_MODEL)
    log.info({ messageId, accountId: msg.folder.account.id }, 'ai: sent message auto-indexed')
  },
}
