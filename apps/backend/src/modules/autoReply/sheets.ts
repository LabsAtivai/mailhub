import { createSign } from 'crypto'
import { scope } from '../../lib/logger'

const log = scope('autoReply')

// Planilha de indicações só com telefone (o agente não tem e-mail para abordar, então a equipe liga).
// Config por ambiente: REFERRAL_SHEET_ID (id da planilha, compartilhada com a conta de serviço como
// editora), GOOGLE_SA_JSON_B64 (JSON da conta de serviço em base64) e, opcional, REFERRAL_SHEET_TAB.
export interface PhoneReferralRow {
  date: Date
  client: string
  mailbox: string
  referrer: string
  subject: string
  name: string
  phone: string
  mode: string
}

export function buildRow(r: PhoneReferralRow): string[] {
  const when = r.date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  return [when, r.client, r.mailbox, r.referrer, r.subject, r.name || '(sem nome)', r.phone, r.mode]
}

export function sheetsConfigured(): boolean {
  return !!process.env.REFERRAL_SHEET_ID && !!process.env.GOOGLE_SA_JSON_B64
}

let cachedToken: { value: string; expiresAt: number } | null = null

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value
  const sa = JSON.parse(Buffer.from(process.env.GOOGLE_SA_JSON_B64 as string, 'base64').toString('utf8')) as { client_email: string; private_key: string }
  const now = Math.floor(Date.now() / 1000)
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  })
  const data = await res.json() as { access_token?: string; expires_in?: number; error_description?: string }
  if (!res.ok || !data.access_token) throw new Error(`Google token: ${data.error_description || res.status}`)
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 }
  return cachedToken.value
}

// Nunca derruba a resposta ao lead: devolve false e registra o motivo se a planilha falhar.
export async function appendPhoneReferral(row: PhoneReferralRow): Promise<boolean> {
  if (!sheetsConfigured()) {
    log.warn({ client: row.client }, 'planilha de indicações não configurada (REFERRAL_SHEET_ID / GOOGLE_SA_JSON_B64)')
    return false
  }
  try {
    const tab = process.env.REFERRAL_SHEET_TAB || 'Indicações'
    const range = encodeURIComponent(`'${tab}'!A:H`)
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${process.env.REFERRAL_SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [buildRow(row)] }),
      },
    )
    if (!res.ok) throw new Error(`Sheets ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return true
  } catch (err) {
    log.error({ client: row.client, reason: err instanceof Error ? err.message : String(err) }, 'falha ao gravar indicação na planilha')
    return false
  }
}
