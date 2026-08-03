import { describe, it, expect } from 'vitest'
import { signAccess, signRefresh, verifyAccess, verifyRefresh, hashRefreshToken } from '../jwt'

describe('jwt', () => {
  const payload = { userId: 'u1', email: 'user@example.com' }

  it('assina e verifica um access token', () => {
    const token = signAccess(payload)
    expect(verifyAccess(token)).toEqual(payload)
  })

  it('assina e verifica um refresh token', () => {
    const token = signRefresh(payload)
    expect(verifyRefresh(token)).toEqual(payload)
  })

  it('gera refresh tokens diferentes pro mesmo payload no mesmo segundo (jti evita colisao)', () => {
    const a = signRefresh(payload)
    const b = signRefresh(payload)
    expect(a).not.toBe(b)
  })

  it('recusa access token verificado com o segredo de refresh', () => {
    const token = signAccess(payload)
    expect(() => verifyRefresh(token)).toThrow()
  })

  it('hashRefreshToken e deterministico e nunca retorna o token original', () => {
    const token = signRefresh(payload)
    const hash1 = hashRefreshToken(token)
    const hash2 = hashRefreshToken(token)
    expect(hash1).toBe(hash2)
    expect(hash1).not.toBe(token)
    expect(hash1).toMatch(/^[0-9a-f]{64}$/)
  })
})
