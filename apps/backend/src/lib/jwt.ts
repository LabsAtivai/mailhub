import jwt from 'jsonwebtoken'
import { randomUUID, createHash } from 'crypto'

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  throw new Error('JWT_SECRET must be set and at least 16 characters')
}
if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET.length < 16) {
  throw new Error('JWT_REFRESH_SECRET must be set and at least 16 characters')
}

const ACCESS_SECRET: string = process.env.JWT_SECRET
const REFRESH_SECRET: string = process.env.JWT_REFRESH_SECRET

export interface JwtPayload {
  userId: string
  email: string
}

export function signAccess(payload: JwtPayload): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '15m' })
}

export function signRefresh(payload: JwtPayload): string {
  // jti garante token único mesmo se emitido no mesmo segundo (iat) pro mesmo
  // usuário — sem isso, dois logins rápidos geram o MESMO JWT (assinatura
  // determinística) e o segundo viola o unique constraint de RefreshToken.token.
  return jwt.sign({ ...payload, jti: randomUUID() }, REFRESH_SECRET, { expiresIn: '7d' })
}

function validatePayload(decoded: string | jwt.JwtPayload): JwtPayload {
  if (typeof decoded === 'string' || !decoded.userId || !decoded.email) {
    throw new Error('Invalid token payload')
  }
  return { userId: decoded.userId as string, email: decoded.email as string }
}

export function verifyAccess(token: string): JwtPayload {
  return validatePayload(jwt.verify(token, ACCESS_SECRET))
}

export function verifyRefresh(token: string): JwtPayload {
  return validatePayload(jwt.verify(token, REFRESH_SECRET))
}

// RefreshToken.token guarda esse hash, nunca o JWT em si — um vazamento de
// backup/réplica do banco não é mais suficiente pra reutilizar sessões
// válidas por até 7 dias. SHA-256 (não Argon2) de propósito: aqui é lookup
// por igualdade num valor já de alta entropia (o próprio JWT), não senha de
// usuário — não precisa de custo computacional alto, só evitar texto puro.
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
