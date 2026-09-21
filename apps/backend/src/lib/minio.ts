import { Client } from 'minio'
import { scope } from './logger'

const log = scope('minio')

export const LARGE_ATTACHMENTS_BUCKET = process.env.MINIO_BUCKET || 'mailhub-large-attachments'

export const minio = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'mailhub-minio',
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || '',
  secretKey: process.env.MINIO_SECRET_KEY || '',
})

let bucketReady: Promise<void> | null = null

// Idempotente e preguiçoso (não bloqueia o boot do backend) — chamado antes de
// cada upload. Bucket privado: nada é servido direto do MinIO, sempre por
// stream via useCases/routes (token controla acesso, não o bucket).
export function ensureBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = minio.bucketExists(LARGE_ATTACHMENTS_BUCKET).then(async (exists) => {
      if (!exists) {
        await minio.makeBucket(LARGE_ATTACHMENTS_BUCKET)
        log.info({ bucket: LARGE_ATTACHMENTS_BUCKET }, 'bucket criado')
      }
    }).catch((err) => {
      bucketReady = null // próxima chamada tenta de novo em vez de ficar presa numa falha
      throw err
    })
  }
  return bucketReady
}
