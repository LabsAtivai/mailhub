import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import http from 'http'
import { Server as SocketServer } from 'socket.io'
import { redis } from './lib/redis'
import { verifyAccess } from './lib/jwt'
// BigInt não serializa nativamente para JSON — fix global
;(BigInt.prototype as any).toJSON = function () { return this.toString() }

import authRoutes from './modules/auth/routes'
import accountRoutes from './modules/accounts/routes'
import folderRoutes from './modules/folders/routes'
import messageRoutes from './modules/messages/routes'
import labelRoutes from './modules/labels/routes'
import { logger } from './lib/logger'

const app = express()
const server = http.createServer(app)

const io = new SocketServer(server, {
  cors: { origin: process.env.CORS_ORIGIN, credentials: true },
})

// ── middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }))
app.use(express.json({ limit: '26mb' }))
app.use(cookieParser())

// ── routes ──────────────────────────────────────────────────────────────────
app.use('/auth', authRoutes)
app.use('/accounts', accountRoutes)
app.use('/accounts', folderRoutes)
app.use('/', messageRoutes)
app.use('/labels', labelRoutes)

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
  // client joins rooms for its accounts
  socket.on('join:account', (accountId: string) => {
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
    if (payload.accountId) {
      io.to(`account:${payload.accountId}`).emit(channel, payload)
    }
  } catch { /* ignore malformed */ }
})

// ── healthcheck ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3001
server.listen(PORT, () => logger.info({ port: PORT }, 'mailhub-backend listening'))
