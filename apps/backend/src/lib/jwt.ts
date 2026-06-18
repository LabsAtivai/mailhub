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

export function verifyAccess(token: string): JwtPayload {
  return jwt.verify(token, ACCESS_SECRET) as unknown as JwtPayload
}

export function verifyRefresh(token: string): JwtPayload {
  return jwt.verify(token, REFRESH_SECRET) as unknown as JwtPayload
}
