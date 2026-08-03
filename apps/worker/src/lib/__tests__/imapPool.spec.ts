import { describe, it, expect, vi, beforeEach } from 'vitest'

let connectCalls = 0

vi.mock('imapflow', () => {
  class FakeImapFlow {
    usable = false
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
    constructor(_opts: unknown) {}
    on(event: string, cb: (...args: unknown[]) => void) {
      (this.listeners[event] ??= []).push(cb)
      return this
    }
    removeAllListeners() { this.listeners = {} }
    async connect() {
      connectCalls++
      await new Promise(resolve => setTimeout(resolve, 30))
      this.usable = true
    }
    async logout() { this.usable = false }
    close() { this.usable = false }
  }
  return { ImapFlow: FakeImapFlow }
})

vi.mock('../logger', () => ({
  scope: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })
}))

import { ImapPool } from '../imapPool'

describe('ImapPool', () => {
  beforeEach(() => { connectCalls = 0 })

  it('deduplica conexoes concorrentes pra mesma conta+tipo (corrida real que causava conexoes duplicadas)', async () => {
    const pool = new ImapPool()
    const opts = {} as never
    const [a, b, c] = await Promise.all([
      pool.connect('acc1', 'ops', opts),
      pool.connect('acc1', 'ops', opts),
      pool.connect('acc1', 'ops', opts),
    ])
    expect(connectCalls).toBe(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('abre conexoes separadas pra contas diferentes', async () => {
    const pool = new ImapPool()
    const opts = {} as never
    await Promise.all([
      pool.connect('acc1', 'ops', opts),
      pool.connect('acc2', 'ops', opts),
    ])
    expect(connectCalls).toBe(2)
  })

  it('abre conexoes separadas pra tipos diferentes da mesma conta (respeitando o teto de 3 por conta)', async () => {
    const pool = new ImapPool()
    const opts = {} as never
    await Promise.all([
      pool.connect('acc1', 'ops', opts),
      pool.connect('acc1', 'idle', opts),
      pool.connect('acc1', 'interactive', opts),
    ])
    expect(connectCalls).toBe(3)
  })

  it('reutiliza o cliente ja conectado em vez de reconectar', async () => {
    const pool = new ImapPool()
    const opts = {} as never
    const first = await pool.connect('acc1', 'ops', opts)
    const second = await pool.connect('acc1', 'ops', opts)
    expect(connectCalls).toBe(1)
    expect(first).toBe(second)
  })
})
