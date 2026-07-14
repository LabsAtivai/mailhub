import { scope } from './logger'
import { ImapFlow, ImapFlowOptions } from 'imapflow'

export type ClientKind = 'ops' | 'idle' | 'interactive'

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

    // Registrar ANTES de conectar, não depois: se o connect() estourar o
    // timeout abaixo, a tentativa continua rodando em background (promises
    // não cancelam) e, sem um listener já preso nela, um erro emitido depois
    // (ex: "Already logged out") sobe como exceção não tratada e derruba o
    // processo do worker inteiro — foi exatamente isso que aconteceu em
    // produção. Com os listeners já ativos, esse erro só é logado.
    client.on('error', (err: Error) => {
      log.error({ key: k, err: err.message }, 'connection error')
      client.removeAllListeners()
      this.clients.delete(k)
    })
    client.on('close', () => {
      client.removeAllListeners()
      this.clients.delete(k)
    })

    try {
      await Promise.race([
        client.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`IMAP connect timeout for ${accountId}:${kind}`)), 30_000)
        ),
      ])
    } catch (err) {
      // O timeout venceu a corrida (ou connect() rejeitou de outra forma):
      // fecha a tentativa explicitamente em vez de deixá-la órfã rodando
      // sozinha. Os listeners acima já cobrem qualquer erro/close que ainda
      // saia dela depois disso.
      client.close()
      throw err
    }

    this.clients.set(k, client)
    return client
  }

  get(accountId: string, kind: ClientKind): ImapFlow | undefined {
    const c = this.clients.get(this.key(accountId, kind))
    return c?.usable ? c : undefined
  }

  async disconnectKind(accountId: string, kind: ClientKind): Promise<void> {
    const k = this.key(accountId, kind)
    const client = this.clients.get(k)
    if (!client) return
    client.removeAllListeners()
    await client.logout().catch(() => {})
    this.clients.delete(k)
  }

  async disconnect(accountId: string): Promise<void> {
    for (const kind of ['ops', 'idle', 'interactive'] as ClientKind[]) {
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
