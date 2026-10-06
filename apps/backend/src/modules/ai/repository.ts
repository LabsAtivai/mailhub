import { prisma } from '../../lib/prisma'

export interface SimilarSentMessage {
  id: string
  subject: string | null
  textBody: string | null
  toJson: string
  date: Date
  distance: number
}

export interface SentMessagePendingEmbedding {
  id: string
  subject: string | null
  textBody: string | null
}

export interface SentMessageForDomain {
  id: string
  subject: string | null
  textBody: string | null
  hasEmbedding: boolean
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

export const aiRepository = {
  // Busca semântica: respostas anteriores da pasta Sent da mesma conta,
  // ordenadas por distância de cosseno ao embedding do e-mail recebido.
  async findSimilarSentMessages(accountId: string, embedding: number[], excludeMessageId: string, limit = 5) {
    const vector = toVectorLiteral(embedding)
    return prisma.$queryRaw<SimilarSentMessage[]>`
      SELECT m.id, m.subject, m."textBody", m."toJson", m.date,
             (me.embedding <=> ${vector}::vector) AS distance
      FROM "MessageEmbedding" me
      JOIN "Message" m ON m.id = me."messageId"
      JOIN "Folder" f ON f.id = m."folderId"
      WHERE f."accountId" = ${accountId}
        AND f."specialUse" = '\\Sent'
        AND m.id != ${excludeMessageId}
      ORDER BY distance ASC
      LIMIT ${limit}
    `
  },

  async upsertEmbedding(messageId: string, embedding: number[], model: string) {
    const vector = toVectorLiteral(embedding)
    await prisma.$executeRaw`
      INSERT INTO "MessageEmbedding" ("messageId", embedding, model, "createdAt")
      VALUES (${messageId}, ${vector}::vector, ${model}, now())
      ON CONFLICT ("messageId")
      DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, "createdAt" = now()
    `
  },

  // Sent messages com corpo já sincronizado (AP-007: lazy body) que ainda não
  // têm embedding — candidatos pra indexação.
  async findSentMessagesPendingEmbedding(accountId: string, limit = 200) {
    return prisma.$queryRaw<SentMessagePendingEmbedding[]>`
      SELECT m.id, m.subject, m."textBody"
      FROM "Message" m
      JOIN "Folder" f ON f.id = m."folderId"
      LEFT JOIN "MessageEmbedding" me ON me."messageId" = m.id
      WHERE f."accountId" = ${accountId}
        AND f."specialUse" = '\\Sent'
        AND m."textBody" IS NOT NULL
        AND me."messageId" IS NULL
      LIMIT ${limit}
    `
  },

  // Backfill escopado: todo Sent endereçado a esse domínio, com ou sem corpo
  // já buscado, pra saber tanto quem já dá pra embedar na hora quanto quem
  // ainda precisa passar pelo fetch de corpo (lazy, AP-007) antes.
  async findSentMessagesForDomain(accountId: string, domain: string, limit = 500) {
    return prisma.$queryRaw<SentMessageForDomain[]>`
      SELECT m.id, m.subject, m."textBody", (me."messageId" IS NOT NULL) AS "hasEmbedding"
      FROM "Message" m
      JOIN "Folder" f ON f.id = m."folderId"
      LEFT JOIN "MessageEmbedding" me ON me."messageId" = m.id
      WHERE f."accountId" = ${accountId}
        AND f."specialUse" = '\\Sent'
        AND m."toJson" ILIKE ${'%@' + domain + '%'}
      LIMIT ${limit}
    `
  },
}
