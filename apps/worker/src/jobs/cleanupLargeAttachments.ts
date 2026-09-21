import { prisma } from '../lib/prisma'
import { minio, LARGE_ATTACHMENTS_BUCKET } from '../lib/minio'
import { scope } from '../lib/logger'

const log = scope('large-attachments-cleanup')

// Varredura dos links de anexo grande (MinIO) vencidos — o download em si já
// varre lazy (ver backend/src/modules/largeAttachments/useCases.ts), isso
// cobre o caso de ninguém nunca ter clicado no link.
export async function cleanupExpiredLargeAttachments(): Promise<void> {
  const expired = await prisma.largeAttachment.findMany({ where: { expiresAt: { lt: new Date() } } })
  if (expired.length === 0) return

  let removed = 0
  for (const att of expired) {
    try {
      await minio.removeObject(LARGE_ATTACHMENTS_BUCKET, att.storageKey)
      await prisma.largeAttachment.delete({ where: { id: att.id } })
      removed++
    } catch (err) {
      log.error({ id: att.id, err: err instanceof Error ? err.message : String(err) }, 'falha ao remover anexo grande vencido')
    }
  }
  log.info({ total: expired.length, removed }, 'limpeza de anexos grandes vencidos concluída')
}
