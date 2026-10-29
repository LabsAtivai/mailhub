// Filtros de segurança do respondedor automático. Funções puras: decidem se
// uma mensagem recebida pode receber resposta automática.

const AUTO_SUBJECT = [
  'auto-resposta', 'auto resposta', 'resposta automática', 'resposta automatica',
  'automatic reply', 'auto-reply', 'autoreply', 'out of office', 'fora do escritório',
  'fora do escritorio', 'undeliverable', 'delivery status', 'delivery failure',
  'returned mail', 'mail delivery failed', 'requires verification', '[!!spam]',
  'notification:',
]

const AUTO_FROM = [
  'noreply@', 'no-reply@', 'no_reply@', 'donotreply@', 'do-not-reply@',
  'mailer-daemon@', 'postmaster@', 'bounce', 'notifications@', 'calendar@',
  'titan.email', 'mimecast', 'ironport', 'cloudhq', 'mailking',
]

const OPT_OUT = [
  'descadastr', 'remova meu', 'remover meu', 'me remov', 'não me envie', 'nao me envie',
  'não quero receber', 'nao quero receber', 'pare de enviar', 'unsubscribe', 'stop sending',
  'sair da lista', 'cancelar inscrição', 'cancelar inscricao',
]

export type SkipReason =
  | 'self' | 'automatic' | 'noreply' | 'opt_out' | 'empty' | 'thread_recent' | 'daily_limit'

export function isSelf(fromEmail: string, accountEmail: string): boolean {
  return fromEmail.trim().toLowerCase() === accountEmail.trim().toLowerCase()
}

export function isAutomatic(fromEmail: string, subject: string): SkipReason | null {
  const from = fromEmail.toLowerCase()
  const subj = subject.toLowerCase()
  if (AUTO_FROM.some(k => from.includes(k))) return 'noreply'
  if (AUTO_SUBJECT.some(k => subj.includes(k))) return 'automatic'
  return null
}

// Pedido de descadastro não recebe pitch: o agente só confirma remoção (regra
// já no system prompt) — aqui só marcamos pro log/lista de não contatar.
export function looksLikeOptOut(body: string): boolean {
  const text = body.toLowerCase().slice(0, 1500)
  return OPT_OUT.some(k => text.includes(k))
}

export function threadKeyOf(subject: string): string {
  let s = subject.toLowerCase()
  for (;;) {
    const n = s.replace(/^\s*((re|res|fw|fwd|enc|encaminhado)\s*:\s*)/, '')
    if (n === s) break
    s = n
  }
  return s.replace(/\s+/g, ' ').trim().slice(0, 200)
}

const FORWARD_MARK = '---------- Mensagem recebida (reenvio de teste) ----------'

// Reenvios de teste chegam com o remetente real citado no topo do corpo (a API
// de envio não permite alterar o "De"). Extrai o remetente/assunto originais
// pra o agente raciocinar sobre o lead de verdade.
export function unwrapForwarded(body: string): { fromEmail: string; subject: string; body: string } | null {
  if (!body.startsWith(FORWARD_MARK)) return null
  const end = body.indexOf('----------------------------------------------------------')
  if (end < 0) return null
  const header = body.slice(FORWARD_MARK.length, end)
  const from = /De:.*?<([^>\s]+)>/.exec(header)?.[1]
  const subject = /Assunto original:\s*(.*)/.exec(header)?.[1]?.trim()
  if (!from) return null
  return {
    fromEmail: from.toLowerCase(),
    subject: subject || '',
    body: body.slice(end + 58).trim(),
  }
}
