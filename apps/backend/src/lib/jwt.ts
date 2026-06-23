import jwt from 'jsonwebtoken'

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
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: '7d' })
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
