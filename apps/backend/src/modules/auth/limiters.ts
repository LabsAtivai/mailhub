import { Request } from 'express'
import rateLimit from 'express-rate-limit'

// Muitos usuários compartilham o mesmo IP, então um limite único por IP (que
// contava login, registro e refresh juntos) travava o time inteiro. Aqui cada
// rota tem o limite que faz sentido pra ela:
//
// - login por E-MAIL: só falhas contam (skipSuccessfulRequests). É a proteção real
//   contra adivinhar a senha de UMA conta, e não depende do IP.
// - login por IP: só falhas contam. Pega quem testa muitas contas (credential
//   stuffing) e é folgado o bastante pra um escritório inteiro errando senha.
// - refresh: o token é um JWT assinado (não dá pra adivinhar) e é renovado
//   automaticamente pelo frontend, então o limite por IP é só um teto anti-abuso.
// - registro: raro, por IP.

const WINDOW_MS = 15 * 60 * 1000
const MESSAGE = { error: 'Muitas tentativas, tente novamente em 15 minutos' }

const common = { windowMs: WINDOW_MS, standardHeaders: true, legacyHeaders: false, message: MESSAGE } as const

function emailKey(req: Request): string {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  return email ? `email:${email}` : `ip:${req.ip ?? 'unknown'}`
}

export const loginEmailLimiter = rateLimit({
  ...common,
  limit: Number(process.env.AUTH_LOGIN_EMAIL_MAX || 10),
  skipSuccessfulRequests: true,
  keyGenerator: emailKey,
})

export const loginIpLimiter = rateLimit({
  ...common,
  limit: Number(process.env.AUTH_LOGIN_IP_MAX || 100),
  skipSuccessfulRequests: true,
  keyGenerator: (req) => req.ip ?? 'unknown',
})

export const refreshLimiter = rateLimit({
  ...common,
  limit: Number(process.env.AUTH_REFRESH_IP_MAX || 600),
  keyGenerator: (req) => req.ip ?? 'unknown',
})

export const registerLimiter = rateLimit({
  ...common,
  limit: Number(process.env.AUTH_REGISTER_IP_MAX || 20),
  keyGenerator: (req) => req.ip ?? 'unknown',
})
