import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import http from 'http'
import nodemailer from 'nodemailer'
import { Server as SocketServer } from 'socket.io'
import { redis } from './lib/redis'
import { prisma } from './lib/prisma'
import { verifyAccess } from './lib/jwt'
import { decrypt } from './lib/crypto'
import { logger } from './lib/logger'

import authRoutes from './modules/auth/routes'
import accountRoutes from './modules/accounts/routes'
import folderRoutes from './modules/folders/routes'
import messageRoutes from './modules/messages/routes'
import labelRoutes from './modules/labels/routes'
import adminRoutes from './modules/admin/routes'

const app = express()
app.set('trust proxy', 1)
const server = http.createServer(app)

const io = new SocketServer(server, {
  cors: { origin: process.env.CORS_ORIGIN, credentials: true },
})

// BigInt serialization via Express json replacer (no global prototype mutation)
app.set('json replacer', (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value
)

// ── middleware ──────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      imgSrc: ["'self'", 'data:'],
      frameSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}))
app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }))
app.use(express.json({ limit: '28mb' })) // acomoda anexos de até 20MB (base64 infla ~33%)
app.use(cookieParser())

// ── healthcheck (antes das rotas autenticadas) ──────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    await redis.ping()
    res.json({ ok: true })
  } catch {
    res.status(503).json({ ok: false })
  }
})

// ── routes ──────────────────────────────────────────────────────────────────
app.use('/auth', authRoutes)
app.use('/accounts', accountRoutes)
app.use('/accounts', folderRoutes)
app.use('/', messageRoutes)
app.use('/labels', labelRoutes)
app.use('/admin', adminRoutes)

// ── Socket.IO auth ──────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token
  if (!token) return next(new Error('Unauthorized'))
  try {
    const payload = verifyAccess(token)
    socket.data.userId = payload.userId
    next()
  } catch {
    next(new Error('Invalid token'))
  }
})

io.on('connection', (socket) => {
  socket.on('join:account', async (accountId: string) => {
    if (!accountId || typeof accountId !== 'string') return
    const account = await prisma.mailAccount.findFirst({
      where: { id: accountId, userId: socket.data.userId },
      select: { id: true },
    })
    if (!account) return
    socket.join(`account:${accountId}`)
  })

  socket.on('leave:account', (accountId: string) => {
    socket.leave(`account:${accountId}`)
  })
})

// ── Redis → Socket.IO relay ─────────────────────────────────────────────────
const redisSub = redis.duplicate()

const EVENTS = [
  'mail:new', 'mail:updated', 'mail:deleted', 'mail:bodyReady',
  'folder:counts', 'account:syncState',
]

redisSub.subscribe(...EVENTS, (err) => {
  if (err) logger.error({ err }, 'redis subscribe error')
})

redisSub.on('message', (channel: string, message: string) => {
  try {
    const payload = JSON.parse(message)
    if (!payload.accountId) {
      logger.warn({ channel }, 'redis message missing accountId')
      return
    }
    io.to(`account:${payload.accountId}`).emit(channel, payload)

    if (channel === 'mail:bodyReady' && payload.messageId) {
      forwardIfEnabled(payload.accountId, payload.messageId).catch(err =>
        logger.error({ err, accountId: payload.accountId, messageId: payload.messageId }, 'auto-forward error')
      )
    }
  } catch (err) {
    logger.error({ channel, err }, 'redis message parse error')
  }
})

async function forwardIfEnabled(accountId: string, messageId: string) {
  const account = await prisma.mailAccount.findFirst({
    where: { id: accountId, forwardEnabled: true },
    select: {
      forwardTo: true, displayName: true, emailAddress: true,
      outgoingHost: true, outgoingPort: true, tlsMode: true,
      username: true, encryptedPassword: true,
    },
  })
  if (!account?.forwardTo) return

  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    select: { subject: true, fromName: true, fromEmail: true, htmlBody: true, textBody: true, messageId: true },
  })
  if (!msg) return

  const isSendGrid = account.outgoingHost === 'smtp.sendgrid.net'
  const smtpAuth = isSendGrid
    ? { user: 'apikey', pass: process.env.SENDGRID_API_KEY ?? '' }
    : { user: account.username, pass: decrypt(account.encryptedPassword) }

  const transporter = nodemailer.createTransport({
    host: account.outgoingHost,
    port: account.outgoingPort,
    secure: account.tlsMode === 'TLS',
    auth: smtpAuth,
  })

  const from = msg.fromName ? `${msg.fromName} <${msg.fromEmail}>` : msg.fromEmail
  try {
    await transporter.sendMail({
      from: `${account.displayName} <${account.emailAddress}>`,
      to: account.forwardTo,
      subject: `Fwd: ${msg.subject ?? '(sem assunto)'}`,
      html: msg.htmlBody ?? msg.textBody ?? '',
      text: msg.textBody ?? '',
      replyTo: from ?? undefined,
    })
    logger.info({ accountId, messageId, forwardTo: account.forwardTo }, 'email auto-forwarded')
  } finally {
    transporter.close()
  }
}

// ── global error handler ────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'unhandled route error')
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => logger.info({ port: PORT }, 'mailhub-backend listening'))

// ── graceful shutdown ───────────────────────────────────────────────────────
async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  server.close()
  redisSub.disconnect()
  redis.disconnect()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
