import { Client } from 'minio'

export const LARGE_ATTACHMENTS_BUCKET = process.env.MINIO_BUCKET || 'mailhub-large-attachments'

export const minio = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'mailhub-minio',
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || '',
  secretKey: process.env.MINIO_SECRET_KEY || '',
})
