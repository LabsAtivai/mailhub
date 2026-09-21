import { Router, Request, Response } from 'express'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import { requireAuth, AuthRequest } from '../../middleware/auth'
import { largeAttachmentUseCases as uc, MAX_LARGE_ATTACHMENT_BYTES } from './useCases'
import { NotFoundError, ValidationError } from '../messages/useCases'
import { scope } from '../../lib/logger'

const log = scope('large-attachments')
const router = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LARGE_ATTACHMENT_BYTES, files: 1 },
})

// Sobe pra ~3/min por usuário — arquivo grande já é naturalmente raro/lento,
// isso só freia abuso.
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId || req.ip || 'unknown',
  message: { error: 'Muitos uploads em pouco tempo. Aguarde um pouco e tente de novo.' },
})

// Sem auth (destinatário do e-mail não é usuário do MailHub) — token de 32
// bytes aleatórios (base64url) é a única credencial. Rate limit por IP evita
// varredura de tokens por força bruta.
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde um pouco e tente de novo.' },
})

function handle(res: Response, err: unknown) {
  if (err instanceof NotFoundError) { res.status(404).json({ error: err.message }); return }
  if (err instanceof ValidationError) { res.status(400).json({ error: err.message }); return }
  log.error({ err }, 'unhandled error in large-attachments module')
  res.status(500).json({ error: 'Internal server error' })
}

// POST /large-attachments — usuário autenticado sobe o arquivo, recebe um link
router.post('/large-attachments', requireAuth, uploadLimiter, upload.single('file'), async (req: AuthRequest, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'Nenhum arquivo enviado' }); return }
  try {
    res.status(201).json(await uc.upload(req.userId!, req.file))
  } catch (err) { handle(res, err) }
})

// Erros do multer (arquivo grande demais) chegam aqui — precisa vir antes do
// handler de erro global do index.ts, por isso mora no próprio router.
router.use((err: Error, _req: Request, res: Response, next: (err?: Error) => void) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Arquivo excede o limite de ${MAX_LARGE_ATTACHMENT_BYTES / 1024 / 1024}MB` : err.message })
    return
  }
  next(err)
})

// GET /large-attachments/:token — download público, sem auth
router.get('/large-attachments/:token', downloadLimiter, async (req: Request, res: Response) => {
  try {
    const { stream, filename, mimeType, size } = await uc.download(req.params.token)
    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Length', String(size))
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
    stream.on('error', (err) => {
      log.error({ err: err.message }, 'erro ao ler stream do minio')
      if (!res.headersSent) res.status(500).json({ error: 'Erro ao ler arquivo' })
    })
    stream.pipe(res)
  } catch (err) { handle(res, err) }
})

export default router
