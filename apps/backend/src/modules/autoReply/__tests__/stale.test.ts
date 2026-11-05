import { describe, it, expect } from 'vitest'
import { isStale, MAX_MESSAGE_AGE_MS } from '../filters'

describe('isStale', () => {
  const now = Date.UTC(2026, 10, 5, 12, 0, 0)
  it('mensagem recente não é antiga', () => {
    expect(isStale(new Date(now - 60 * 60 * 1000), now)).toBe(false)
  })
  it('mensagem no limite não é antiga', () => {
    expect(isStale(new Date(now - MAX_MESSAGE_AGE_MS), now)).toBe(false)
  })
  it('mensagem com mais de 24h é antiga', () => {
    expect(isStale(new Date(now - MAX_MESSAGE_AGE_MS - 1), now)).toBe(true)
  })
})
