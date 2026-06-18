import { scope } from './logger'
import { ImapFlow, ImapFlowOptions } from 'imapflow'

export type ClientKind = 'ops' | 'idle'

const log = scope('imap-pool')

export class ImapPool {
  private clients = new Map<string, ImapFlow>()

  private key(accountId: string, kind: ClientKind) {
    return `${accountId}:${kind}`
  }

  async connect(accountId: string, kind: ClientKind, opts: ImapFlowOptions): Promise<ImapFlow> {
    const k = this.key(accountId, kind)
    const existing = this.clients.get(k)
    if (existing?.usable) return existing
    if (existing) {
      existing.removeAllListeners()
      this.clients.delete(k)
    }

    const client = new ImapFlow({ ...opts, logger: false })
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`IMAP connect timeout for ${accountId}:${kind}`)), 30_000)
      ),
    ])
    this.clients.set(k, client)

    client.on('error', (err: Error) => {
      log.error({ key: k, err: err.message }, 'connection error')
      client.removeAllListeners()
      this.clients.delete(k)
    })
    client.on('close', () => {
      client.removeAllListeners()
      this.clients.delete(k)
    })

    return client
  }

  get(accountId: string, kind: ClientKind): ImapFlow | undefined {
    const c = this.clients.get(this.key(accountId, kind))
    return c?.usable ? c : undefined
  }

  async disconnect(accountId: string): Promise<void> {
    for (const kind of ['ops', 'idle'] as ClientKind[]) {
      const k = this.key(accountId, kind)
      const client = this.clients.get(k)
      if (client) {
        client.removeAllListeners()
        await client.logout().catch(() => {})
        this.clients.delete(k)
      }
    }
  }

  async disconnectAll(): Promise<void> {
    const ids = new Set([...this.clients.keys()].map(k => k.split(':')[0]))
    for (const id of ids) await this.disconnect(id)
  }
}

export const pool = new ImapPool()
