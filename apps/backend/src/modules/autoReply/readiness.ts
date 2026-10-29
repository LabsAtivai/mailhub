import { prisma } from '../../lib/prisma'

// Verificação de prontidão para o modo `live`. Bloqueios impedem ligar o envio
// ao lead; avisos só pedem revisão humana. Ver docs/autoreply-producao.md.

export interface Finding { code: string; message: string }
export interface Readiness {
  ok: boolean
  blockers: Finding[]
  warnings: Finding[]
  stats: { chunks: number; sources: number; drafts: number; testSent: number; errors: number; envEnabled: boolean }
}

const MIN_TEST_SENT = 5
const MIN_DRAFTS_WARN = 20
const MAX_ERROR_RATE = 0.2

// Rascunhos que o agente poderia copiar para o e-mail do lead.
const PLACEHOLDER = /\(confirmar\)|\(nome[^)]{0,30}\)|\(empresa\)|\{\{[^}]*\}\}|\[(?:seu|sua|nome|empresa|cargo)[^\]]*\]|lorem ipsum/i
// Dados que não devem ir para o lead.
const CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/
const SECRET = /\bSG\.[\w-]{10,}|\bAKIA[0-9A-Z]{12,}|\bxsmtpsib-|\b(?:senha|password|passwd)\s*[:=]/i
// Conteúdo do onboarding da Ativa.ai, e não da oferta do cliente.
const ATIVA_GENERIC = /ativa\.live|speed to lead|lista negativa|sdr remoto|área de treinamento|go live/i

export function scanText(text: string): { placeholder: boolean; cnpj: boolean; secret: boolean; generic: boolean } {
  return {
    placeholder: PLACEHOLDER.test(text),
    cnpj: CNPJ.test(text),
    secret: SECRET.test(text),
    generic: ATIVA_GENERIC.test(text),
  }
}

export async function checkReadiness(accountId: string): Promise<Readiness> {
  const blockers: Finding[] = []
  const warnings: Finding[] = []
  const envEnabled = process.env.AUTOREPLY_ENABLED === 'true'

  const cfg = await prisma.autoReplyConfig.findUnique({ where: { accountId } })

  let rows: Array<{ source: string; content: string }> = []
  try {
    rows = await prisma.$queryRaw<Array<{ source: string; content: string }>>`
      SELECT source, content FROM "ClientKnowledgeChunk" WHERE "accountId" = ${accountId}`
  } catch { /* tabela ainda não criada: tratada como base vazia */ }

  const bySource = new Map<string, { placeholder: boolean; cnpj: boolean; secret: boolean; generic: number; total: number }>()
  for (const r of rows) {
    const s = bySource.get(r.source) ?? { placeholder: false, cnpj: false, secret: false, generic: 0, total: 0 }
    const f = scanText(r.content)
    s.placeholder ||= f.placeholder; s.cnpj ||= f.cnpj; s.secret ||= f.secret
    s.generic += f.generic ? 1 : 0; s.total += 1
    bySource.set(r.source, s)
  }

  if (!envEnabled) blockers.push({ code: 'env_disabled', message: 'AUTOREPLY_ENABLED não está true no backend.' })
  if (!cfg) blockers.push({ code: 'no_config', message: 'Caixa sem configuração do agente.' })
  if (cfg && !cfg.clientName.trim()) blockers.push({ code: 'no_client_name', message: 'clientName vazio.' })
  if (cfg && !cfg.signature.trim()) blockers.push({ code: 'no_signature', message: 'Assinatura vazia: as respostas sairiam sem assinatura.' })
  if (cfg && PLACEHOLDER.test(cfg.signature)) blockers.push({ code: 'signature_placeholder', message: 'Assinatura com campo não preenchido.' })
  if (!rows.length) blockers.push({ code: 'no_knowledge', message: 'Base de conhecimento vazia.' })

  for (const [source, s] of bySource) {
    if (s.placeholder) blockers.push({ code: 'placeholder', message: `${source}: contém campo não preenchido, ex: "(confirmar)" ou "(nome do indicado)".` })
    if (s.cnpj) blockers.push({ code: 'cnpj', message: `${source}: contém CNPJ.` })
    if (s.secret) blockers.push({ code: 'secret', message: `${source}: parece conter credencial ou senha.` })
    if (s.generic > 0) warnings.push({ code: 'generic_ativa', message: `${source}: ${s.generic} de ${s.total} trechos parecem do onboarding da Ativa.ai, e não da oferta do cliente.` })
  }

  const grouped = await prisma.autoReplyLog.groupBy({ by: ['status'], where: { accountId }, _count: { _all: true } })
  const n = (s: string) => grouped.find(g => g.status === s)?._count._all ?? 0
  const drafts = n('shadow') + n('test_sent')
  const testSent = n('test_sent')
  const errors = n('error')
  const processed = drafts + n('sent') + errors

  if (testSent < MIN_TEST_SENT) blockers.push({ code: 'not_tested', message: `Só ${testSent} resposta(s) em modo teste; são necessárias ${MIN_TEST_SENT} antes do live.` })
  if (processed > 0 && errors / processed > MAX_ERROR_RATE) blockers.push({ code: 'error_rate', message: `Taxa de erro de ${Math.round((errors / processed) * 100)}% (máx. ${MAX_ERROR_RATE * 100}%).` })
  if (drafts < MIN_DRAFTS_WARN) warnings.push({ code: 'few_drafts', message: `Só ${drafts} rascunho(s) avaliado(s); recomendado revisar ${MIN_DRAFTS_WARN}+.` })
  if (cfg && cfg.dailyLimit > 100) warnings.push({ code: 'high_limit', message: `Limite diário de ${cfg.dailyLimit}; considere começar com 30 a 50 no live.` })

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    stats: { chunks: rows.length, sources: bySource.size, drafts, testSent, errors, envEnabled },
  }
}
