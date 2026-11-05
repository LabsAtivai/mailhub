import { prisma } from '../../lib/prisma'
import { scope } from '../../lib/logger'

const log = scope('autoReply.snov')
const API = 'https://api.snov.io'
const MAX_ATTEMPTS = 10
const BATCH = 100 // limite do Snov por chamada

// Gerenciador de credenciais (snov-am-api, rede docker ativaai). Chave com scope credentials:read.
// Cada leitura de credencial é auditada lá, então só buscamos quando o token expira.
async function fetchCredentials(snovAccountId: string): Promise<{ clientId: string; clientSecret: string }> {
  const base = process.env.CREDENTIALS_API_URL
  const key = process.env.CREDENTIALS_API_KEY
  if (!base || !key) throw new Error('CREDENTIALS_API_URL/CREDENTIALS_API_KEY não configurados')
  const r = await fetch(`${base.replace(/\/$/, '')}/api/internal/accounts/${encodeURIComponent(snovAccountId)}/credentials`, {
    headers: { 'X-API-Key': key },
  })
  if (!r.ok) throw new Error(`credenciais ${r.status}`)
  const j = await r.json() as { snov_id?: string; snov_secret?: string }
  if (!j.snov_id || !j.snov_secret) throw new Error('conta sem snov_id/snov_secret no gerenciador')
  return { clientId: j.snov_id, clientSecret: j.snov_secret }
}

export async function listSnovAccounts(q?: string): Promise<Array<{ id: string; email: string; status: string; description?: string | null }>> {
  const base = process.env.CREDENTIALS_API_URL
  const key = process.env.CREDENTIALS_API_KEY
  if (!base || !key) throw new Error('CREDENTIALS_API_URL/CREDENTIALS_API_KEY não configurados')
  const url = new URL(`${base.replace(/\/$/, '')}/api/accounts`)
  url.searchParams.set('page_size', '100')
  if (q) url.searchParams.set('q', q)
  const r = await fetch(url, { headers: { 'X-API-Key': key } })
  if (!r.ok) throw new Error(`contas ${r.status}`)
  const j = await r.json() as { items?: Array<{ id: string; email: string; status: string; description?: string | null }> }
  return (j.items ?? []).map(a => ({ id: a.id, email: a.email, status: a.status, description: a.description }))
}

const tokens = new Map<string, { token: string; expiresAt: number }>()

async function accessToken(clientKey: string, clientId: string, clientSecret: string): Promise<string> {
  const cached = tokens.get(clientKey)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
  const r = await fetch(`${API}/v1/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  })
  if (!r.ok) throw new Error(`snov oauth ${r.status}`)
  const j = await r.json() as { access_token?: string; expires_in?: number }
  if (!j.access_token) throw new Error('snov oauth sem access_token')
  tokens.set(clientKey, { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 })
  return j.access_token
}

// Envia até 100 e-mails para a lista Do-Not-Email do cliente. Duplicado conta como ok.
// Retorna os e-mails que o Snov rejeitou (inválidos) para não ficarem em retentativa eterna.
async function pushBatch(clientKey: string, emails: string[]): Promise<{ rejected: Set<string> }> {
  const cfg = await prisma.clientSnovConfig.findUnique({ where: { clientKey } })
  if (!cfg) throw new Error('cliente sem credenciais Snov')
  let token = tokens.get(clientKey)?.token
  if (!token || (tokens.get(clientKey)?.expiresAt ?? 0) <= Date.now() + 60_000) {
    const c = await fetchCredentials(cfg.snovAccountId)
    token = await accessToken(clientKey, c.clientId, c.clientSecret)
  }
  if (!cfg.listIds.length) throw new Error('cliente sem listas Do-Not-Email configuradas')
  // Envia para todas as listas do cliente; se qualquer uma falhar, o lote inteiro fica pendente
  // (reenviar é seguro: duplicado volta como "duplicates", não como erro).
  const rejected = new Set<string>()
  for (const listId of cfg.listIds) {
    const r = await fetch(`${API}/v2/blacklists/${listId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ items: emails }),
    })
    if (r.status === 401) tokens.delete(clientKey)
    if (!r.ok) throw new Error(`snov add lista ${listId}: ${r.status}`)
    const j = await r.json() as { data?: { rejected?: Array<{ item?: string; value?: string }> } }
    for (const x of j.data?.rejected ?? []) {
      const v = (x.item ?? x.value ?? '').toLowerCase()
      if (v) rejected.add(v)
    }
  }
  return { rejected }
}

// Sincroniza pendências. Sem credenciais do cliente a linha fica pendente (sem gastar tentativa)
// e sai sozinha quando as credenciais forem cadastradas.
export async function syncPendingSuppressions(clientKey?: string): Promise<number> {
  const pending = await prisma.autoReplySuppression.findMany({
    where: { snovSyncedAt: null, snovAttempts: { lt: MAX_ATTEMPTS }, ...(clientKey ? { clientKey } : {}) },
    orderBy: { createdAt: 'asc' },
    take: 1000,
  })
  const byClient = new Map<string, typeof pending>()
  for (const p of pending) byClient.set(p.clientKey, [...(byClient.get(p.clientKey) ?? []), p])

  let synced = 0
  for (const [key, rows] of byClient) {
    const has = await prisma.clientSnovConfig.findUnique({ where: { clientKey: key }, select: { clientKey: true } })
    if (!has) continue
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH)
      const ids = chunk.map(c => c.id)
      try {
        const { rejected } = await pushBatch(key, chunk.map(c => c.email))
        await prisma.autoReplySuppression.updateMany({
          where: { id: { in: ids } },
          data: { snovSyncedAt: new Date(), snovError: null },
        })
        if (rejected.size) {
          await prisma.autoReplySuppression.updateMany({
            where: { id: { in: ids }, email: { in: [...rejected] } },
            data: { snovError: 'rejeitado pelo Snov' },
          })
        }
        synced += chunk.length
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn({ clientKey: key, err: msg }, 'snov sync failed')
        await prisma.autoReplySuppression.updateMany({
          where: { id: { in: ids } },
          data: { snovAttempts: { increment: 1 }, snovError: msg.slice(0, 200) },
        })
      }
    }
  }
  return synced
}
