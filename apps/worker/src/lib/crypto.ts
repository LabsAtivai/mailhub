import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'

const keyHex = process.env.ENCRYPTION_KEY
if (!keyHex || keyHex.length !== 64) {
  throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Generate with: openssl rand -hex 32')
}
const KEY = Buffer.from(keyHex, 'hex')

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decrypt(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64')
  if (buf.length < 29) throw new Error('Invalid encrypted data')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const encrypted = buf.subarray(28)
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8')
}
