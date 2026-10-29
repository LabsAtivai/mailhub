import { prisma } from '../../lib/prisma'
import { embedText, EMBEDDING_MODEL } from '../ai/openaiClient'
import { scope } from '../../lib/logger'

const log = scope('autoReply')

const CHUNK_SIZE = 1200
const CHUNK_OVERLAP = 150

export function chunkText(text: string): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return []
  const chunks: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length)
    if (end < clean.length) {
      const cut = clean.lastIndexOf('\n', end)
      if (cut > start + CHUNK_SIZE / 2) end = cut
    }
    chunks.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = end - CHUNK_OVERLAP
  }
  return chunks.filter(c => c.length > 20)
}

// Mesmo esquema do MessageEmbedding: tabela fora do Prisma (tipo vector), criada
// sob demanda. Toda consulta filtra por accountId — nunca há busca cruzada
// entre clientes.
async function ensureTable() {
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`)
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ClientKnowledgeChunk" (
      id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "accountId"  text NOT NULL,
      source       text NOT NULL,
      "chunkIndex" int NOT NULL,
      content      text NOT NULL,
      embedding    vector(1536) NOT NULL,
      model        text NOT NULL,
      "createdAt"  timestamptz NOT NULL DEFAULT now()
    )`)
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "ClientKnowledgeChunk_account_idx" ON "ClientKnowledgeChunk" ("accountId", source)`)
}

// Ingestão idempotente: reenviar o mesmo `source` substitui os chunks antigos.
export async function ingestDocument(accountId: string, source: string, text: string) {
  await ensureTable()
  const chunks = chunkText(text)
  const embeddings: number[][] = []
  for (const c of chunks) embeddings.push(await embedText(c))
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`DELETE FROM "ClientKnowledgeChunk" WHERE "accountId" = ${accountId} AND source = ${source}`
    for (let i = 0; i < chunks.length; i++) {
      const vector = `[${embeddings[i].join(',')}]`
      await tx.$executeRaw`
        INSERT INTO "ClientKnowledgeChunk" ("accountId", source, "chunkIndex", content, embedding, model)
        VALUES (${accountId}, ${source}, ${i}, ${chunks[i]}, ${vector}::vector, ${EMBEDDING_MODEL})`
    }
  })
  log.info({ accountId, source, chunks: chunks.length }, 'knowledge ingested')
  return chunks.length
}

export async function searchKnowledge(accountId: string, query: string, limit = 6): Promise<string[]> {
  try {
    const vector = `[${(await embedText(query)).join(',')}]`
    const rows = await prisma.$queryRaw<Array<{ source: string; content: string }>>`
      SELECT source, content FROM "ClientKnowledgeChunk"
      WHERE "accountId" = ${accountId}
      ORDER BY embedding <=> ${vector}::vector
      LIMIT ${limit}`
    return rows.map(r => `[${r.source}]\n${r.content}`)
  } catch (err) {
    log.warn({ accountId, err: err instanceof Error ? err.message : String(err) }, 'knowledge search failed')
    return []
  }
}

export async function knowledgeStats(accountId: string) {
  await ensureTable()
  const rows = await prisma.$queryRaw<Array<{ source: string; chunks: bigint }>>`
    SELECT source, count(*) AS chunks FROM "ClientKnowledgeChunk"
    WHERE "accountId" = ${accountId} GROUP BY source ORDER BY source`
  return rows.map(r => ({ source: r.source, chunks: Number(r.chunks) }))
}
