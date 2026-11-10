import { generateWithInstructions } from '../ai/openaiClient'
import { scope } from '../../lib/logger'

const log = scope('autoReply')

// O modelo costuma confirmar o que o lead pergunta ("vocês têm garantia estendida?") mesmo sem base no
// material do cliente, e a regra no prompt sozinha não segura isso. Por isso o rascunho passa por uma
// segunda leitura, em código: um revisor lista o que não está sustentado no contexto, o rascunho é
// reescrito sem essas afirmações e conferido de novo. O que sobrar impede o envio em live.
export const GROUND_CHECK_INSTRUCTIONS = `
Você é um revisor de fatos. Recebe o CONTEXTO DO CLIENTE (a única fonte de verdade), o E-MAIL RECEBIDO de um lead e o RASCUNHO de resposta escrito em nome do cliente.

Tarefa: liste as afirmações FACTUAIS do RASCUNHO sobre o cliente (serviços, produtos, funcionalidades, garantias, prazos, preços, condições comerciais, certificações, regiões atendidas, quantidades mínimas, números, clientes e cases, integrações, nota fiscal, formas de contratação, características técnicas) que NÃO estão sustentadas, literalmente ou por sentido claro, no CONTEXTO DO CLIENTE.

Regras:
- Confirmar o que o lead perguntou ("sim, vendemos para CNPJ", "oferecemos garantia estendida") conta como afirmação factual: só está sustentada se o CONTEXTO disser isso.
- Detalhes inventados para soar específico (nomes de softwares, marcas, processos, números) também contam como não sustentados.
- Dizer que vai confirmar com a equipe, pedir informações ao lead, propor uma conversa, saudações, agradecimentos e a assinatura NÃO são afirmações factuais: ignore.
- Frases genéricas de benefício que apenas reformulam o que o contexto diz são sustentadas.
- Se tudo estiver sustentado, devolva lista vazia.

Responda SOMENTE com JSON: {"nao_sustentadas": ["trecho curto", "..."]}
`.trim()

export const GROUND_REWRITE_INSTRUCTIONS = `
Você reescreve um e-mail comercial removendo afirmações que não têm base no CONTEXTO DO CLIENTE.

Para cada afirmação não sustentada listada: não a confirme nem a negue. Ou omita o trecho, ou diga de forma natural que vai confirmar essa informação com a equipe e retornar. Mantenha o restante do e-mail: idioma, tom, estrutura, chamada para conversa e assinatura exatamente como estão. Não acrescente nenhuma informação nova. Retorne somente o texto final do e-mail.
`.trim()

export function parseUnsupported(raw: string): string[] | null {
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as { nao_sustentadas?: unknown }
    if (!Array.isArray(v.nao_sustentadas)) return null
    return v.nao_sustentadas.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim().slice(0, 300))
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
    return parseUnsupported(raw)
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
