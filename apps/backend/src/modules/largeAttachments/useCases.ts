import crypto from 'crypto'
import { minio, ensureBucket, LARGE_ATTACHMENTS_BUCKET } from '../../lib/minio'
import { largeAttachmentRepository as repo } from './repository'
import { NotFoundError, ValidationError } from '../messages/useCases'
import { scope } from '../../lib/logger'

const log = scope('large-attachments')

// SendGrid rejeita mensagem total (headers + anexos em base64) acima de
// 30MB — por isso anexo direto (embutido no e-mail) fica limitado a 20MB
// (ver MAX_ATTACHMENTS_BYTES em messages/useCases.ts). Anexo grande demais
// pra isso vira link: sobe pro MinIO, e-mail leva só a URL de download.
export const MAX_LARGE_ATTACHMENT_BYTES = Number(process.env.LARGE_ATTACHMENT_MAX_MB || 200) * 1024 * 1024
const EXPIRY_DAYS = Number(process.env.LARGE_ATTACHMENT_EXPIRY_DAYS || 30)

function buildDownloadUrl(token: string): string {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')
  return `${base}/large-attachments/${token}`
}

export const largeAttachmentUseCases = {
  async upload(userId: string, file: { originalname: string; mimetype: string; size: number; buffer: Buffer }) {
    if (file.size > MAX_LARGE_ATTACHMENT_BYTES) {
      throw new ValidationError(`Arquivo excede o limite de ${MAX_LARGE_ATTACHMENT_BYTES / 1024 / 1024}MB`)
    }

    await ensureBucket()

    const token = crypto.randomBytes(32).toString('base64url')
    const storageKey = `${userId}/${crypto.randomUUID()}`
    const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000)

    await minio.putObject(LARGE_ATTACHMENTS_BUCKET, storageKey, file.buffer, file.size, {
      'Content-Type': file.mimetype || 'application/octet-stream',
    })

    const record = await repo.create({
      userId,
      token,
      originalFilename: file.originalname,
      mimeType: file.mimetype || 'application/octet-stream',
      size: file.size,
      storageKey,
      expiresAt,
    })

    return {
      token,
      url: buildDownloadUrl(token),
      filename: record.originalFilename,
      size: record.size,
      expiresAt: record.expiresAt,
    }
  },

  async download(token: string) {
    const record = await repo.findByToken(token)
    if (!record) throw new NotFoundError('Link não encontrado ou expirado')

    if (record.expiresAt < new Date()) {
      // Expirado mas ainda não varrido pelo job periódico do worker — trata
      // como se não existisse mais e adianta a limpeza deste registro.
      await minio.removeObject(LARGE_ATTACHMENTS_BUCKET, record.storageKey).catch(() => {})
      await repo.remove(record.id).catch(() => {})
      throw new NotFoundError('Link não encontrado ou expirado')
    }

    const stream = await minio.getObject(LARGE_ATTACHMENTS_BUCKET, record.storageKey)
    repo.incrementDownloadCount(record.id).catch((err) =>
      log.warn({ err: err instanceof Error ? err.message : String(err), id: record.id }, 'falha ao incrementar downloadCount')
    )

    return { stream, filename: record.originalFilename, mimeType: record.mimeType, size: record.size }
  },
}
