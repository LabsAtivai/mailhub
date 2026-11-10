import { generateWithInstructions } from '../ai/openaiClient'
import { scope } from '../../lib/logger'

const log = scope('autoReply')

// O modelo costuma confirmar o que o lead pergunta ("vocês têm garantia estendida?") mesmo sem base no
// material do cliente, e a regra no prompt sozinha não segura isso. Por isso o rascunho passa por uma
// segunda leitura, em código: um revisor lista o que não está sustentado no contexto, o rascunho é
// reescrito sem essas afirmações e conferido de novo. O que sobrar impede o envio em live.
export const GROUND_CHECK_INSTRUCTIONS = `
Você é um revisor de fatos. Recebe o CONTEXTO DO CLIENTE (a única fonte de verdade), o E-MAIL RECEBIDO de um lead e o RASCUNHO de resposta escrito em nome do cliente.

Tarefa: liste TODAS as afirmações FACTUAIS do RASCUNHO sobre o cliente (serviços, produtos, funcionalidades, garantias, prazos, preços, condições comerciais, certificações, regiões atendidas, quantidades mínimas, números, clientes e cases, integrações, nota fiscal, formas de contratação, características técnicas, diferenciais, origem e processo de fabricação). Para CADA afirmação, copie em "evidencia" o trecho LITERAL do CONTEXTO que a sustenta, sem alterar nenhuma palavra. Se não existir esse trecho no CONTEXTO, use null.

Regras:
- Confirmar o que o lead perguntou ("sim, vendemos para CNPJ", "oferecemos garantia estendida") é uma afirmação factual: só tem evidência se o CONTEXTO disser isso. A palavra aparecer no contexto em outro sentido (por exemplo, "CNPJ omitido") não é evidência.
- Detalhes inventados para soar específico (nomes de softwares, marcas, processos, números) são afirmações sem evidência.
- Dizer que vai confirmar com a equipe, pedir informações ao lead, propor uma conversa, saudações, agradecimentos e a assinatura NÃO são afirmações factuais: não liste.
- A evidência precisa ser uma cópia exata de um trecho do CONTEXTO. Nunca invente nem reescreva a citação.

Responda SOMENTE com JSON: {"afirmacoes": [{"afirmacao": "texto curto", "evidencia": "citação literal ou null"}]}
`.trim()

export const GROUND_REWRITE_INSTRUCTIONS = `
Você reescreve um e-mail comercial removendo afirmações que não têm base no CONTEXTO DO CLIENTE.

Para cada afirmação não sustentada listada: não a confirme nem a negue. Ou omita o trecho, ou diga de forma natural que vai confirmar essa informação com a equipe e retornar. Mantenha o restante do e-mail: idioma, tom, estrutura, chamada para conversa e assinatura exatamente como estão. Não acrescente nenhuma informação nova. Retorne somente o texto final do e-mail.
`.trim()

function norm(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// A citação do revisor só vale se existir de fato no contexto: texto contínuo ou, se o modelo trocou
// pontuação ou uma palavra, cobertura alta das sequências de 3 palavras.
export function quoteInContext(quote: string, normContext: string): boolean {
  const q = norm(quote)
  if (q.length < 12) return false
  if (normContext.includes(q)) return true
  const words = q.split(' ')
  if (words.length < 4) return false
  let hit = 0
  const total = words.length - 2
  for (let i = 0; i < total; i++) if (normContext.includes(words.slice(i, i + 3).join(' '))) hit++
  return hit / total >= 0.8
}

// Uma citação real mas curta ou fora do assunto não prova nada (ex.: "CNPJ e e-mail" não sustenta "vendemos
// para CNPJ"). Exige citação com tamanho mínimo e que contenha a maior parte das palavras-chave da afirmação
// (comparadas pelos 5 primeiros caracteres, para absorver flexão: vendemos/venda).
const STOP = new Set(['sobre', 'nossa', 'nosso', 'nossas', 'nossos', 'temos', 'somos', 'ainda', 'também', 'tambem', 'todos', 'todas', 'ajuda', 'ajudam', 'ofere'])
export function quoteSupportsClaim(claim: string, quote: string): boolean {
  const q = norm(quote)
  if (q.length < 25) return false
  const quotePrefixes = new Set(q.split(' ').filter(w => w.length >= 4).map(w => w.slice(0, 5)))
  const keys = norm(claim).split(' ').filter(w => w.length >= 5 && !STOP.has(w.slice(0, 5)) && !STOP.has(w))
  if (!keys.length) return true
  const covered = keys.filter(w => quotePrefixes.has(w.slice(0, 5))).length
  return covered / keys.length >= 0.5
}

// Aceita o formato novo (afirmacoes com evidencia, conferida contra o contexto) e o antigo (nao_sustentadas).
export function parseUnsupported(raw: string, context = ''): string[] | null {
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as { nao_sustentadas?: unknown; afirmacoes?: unknown }
    if (Array.isArray(v.afirmacoes)) {
      const normContext = norm(context)
      const out: string[] = []
      for (const item of v.afirmacoes) {
        if (!item || typeof item !== 'object') continue
        const { afirmacao, evidencia } = item as { afirmacao?: unknown; evidencia?: unknown }
        if (typeof afirmacao !== 'string' || !afirmacao.trim()) continue
        if (typeof evidencia === 'string' && evidencia.trim() && quoteInContext(evidencia, normContext) && quoteSupportsClaim(afirmacao, evidencia)) continue
        out.push(afirmacao.trim().slice(0, 300))
      }
      return out
    }
    if (Array.isArray(v.nao_sustentadas)) {
      return v.nao_sustentadas.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim().slice(0, 300))
    }
    return null
  } catch {
    return null
  }
}

async function check(ctx: { context: string; received: string; draft: string }): Promise<string[] | null> {
  try {
    const raw = await generateWithInstructions(
      GROUND_CHECK_INSTRUCTIONS,
      `### CONTEXTO DO CLIENTE\n${ctx.context.slice(0, 40000)}\n\n### E-MAIL RECEBIDO\n${ctx.received.slice(0, 4000)}\n\n### RASCUNHO\n${ctx.draft}`,
      600,
    )
    return parseUnsupported(raw, ctx.context)
  } catch (err) {
    log.warn({ reason: err instanceof Error ? err.message : String(err) }, 'verificação de fatos falhou')
    return null
  }
}

export interface GroundResult {
  draft: string
  // Afirmações que continuam sem base depois da reescrita. Vazio = sustentado.
  unsupported: string[]
  // false quando a verificação não pôde ser feita (erro do modelo): quem chama decide, em live não envia.
  checked: boolean
  rewritten: boolean
}

export async function groundDraft(ctx: { context: string; received: string; draft: string }): Promise<GroundResult> {
  const first = await check(ctx)
  if (first === null) return { draft: ctx.draft, unsupported: [], checked: false, rewritten: false }
  if (!first.length) return { draft: ctx.draft, unsupported: [], checked: true, rewritten: false }

  let rewritten = ctx.draft
  try {
    rewritten = (await generateWithInstructions(
      GROUND_REWRITE_INSTRUCTIONS,
      `### CONTEXTO DO CLIENTE\n${ctx.context.slice(0, 40000)}\n\n### AFIRMAÇÕES SEM BASE A REMOVER\n${first.map(x => `- ${x}`).join('\n')}\n\n### E-MAIL A REESCREVER\n${ctx.draft}`,
    )).trim()
  } catch (err) {
    log.warn({ reason: err instanceof Error ? err.message : String(err) }, 'reescrita do rascunho falhou')
    return { draft: ctx.draft, unsupported: first, checked: true, rewritten: false }
  }
  if (!rewritten) return { draft: ctx.draft, unsupported: first, checked: true, rewritten: false }

  const second = await check({ ...ctx, draft: rewritten })
  if (second === null) return { draft: rewritten, unsupported: first, checked: false, rewritten: true }
  return { draft: rewritten, unsupported: second, checked: true, rewritten: true }
}
