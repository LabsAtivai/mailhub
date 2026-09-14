const CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini'

export class OpenAiError extends Error {}

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new OpenAiError('OPENAI_API_KEY não configurada')
  return key
}

export type LeadStatus = 'interessado' | 'encaminhamento' | 'negado' | 'outro'
const VALID_STATUSES: LeadStatus[] = ['interessado', 'encaminhamento', 'negado', 'outro']

const SYSTEM_INSTRUCTIONS = `
Você classifica respostas de e-mail recebidas em resposta a uma cadência de prospecção fria (cold outbound, via Snov.io). Dado o assunto e o corpo do e-mail recebido, classifique em EXATAMENTE uma categoria:

- "interessado": PESSOA real demonstra interesse real no que foi oferecido, pede mais informação, quer agendar conversa/reunião/demo — sempre em texto escrito especificamente em resposta ao assunto da cadência.
- "encaminhamento": uma PESSOA, escrevendo ativamente sobre o assunto da cadência, diz que encaminhou ou vai encaminhar a conversa pra outra pessoa/setor (ex: "encaminhei pro responsável", "fale com fulano@empresa.com"), OU o corpo inteiro da resposta é só um nome/e-mail/contato solto (com ou sem assinatura), sem nenhuma frase — sinal de que a pessoa está redirecionando pro contato certo sem escrever explicação (ex: corpo é literalmente "joana@empresa.com" e nada mais, ou "Fulano de Tal, Compras" seguido de assinatura).
- "negado": recusa explícita, diz que não tem interesse, pede pra não receber mais e-mails/remoção da lista.
- "outro": qualquer coisa que não se encaixe claramente acima — resposta automática/fora do escritório, bounce, newsletter, spam, mensagem ambígua, vazia ou sem relação com a cadência.

IMPORTANTE: resposta automática é SEMPRE "outro" — nunca "interessado" nem "encaminhamento" — mesmo quando o texto automático cita outro nome/e-mail pra redirecionar as mensagens (ex: "estarei ausente até dia X, favor direcionar para fulano@empresa.com", "esta conta foi desativada, encaminhar para fulano@empresa.com", "fulano não faz mais parte da empresa, direcionar para beltrano@empresa.com") ou soa educado/receptivo (ex: "obrigado pelo contato, retornaremos em breve", "recebemos sua mensagem"). Isso é um autoresponder mecânico (ausência/férias, conta desativada, funcionário desligado, caixa cheia, confirmação automática de recebimento), não uma pessoa interessada nem encaminhando a conversa de verdade. Sinais de autoresponder: texto genérico/padronizado sem relação com o assunto específico enviado, ausência de saudação pessoal, tom impessoal/repetível pra qualquer remetente, menção a "resposta automática"/"esta é uma mensagem automática" em qualquer lugar do corpo. Prefixo "[EXTERNO]" no assunto é só uma tag de segurança de e-mail corporativo, não indica nada sobre o conteúdo.

Também é "outro" (nunca "interessado"): corpo vazio ou quase vazio, respostas de uma linha sem conteúdo real (ex: só "ok", "recebido"), ou qualquer mensagem que não traga nenhum sinal concreto de interesse — na dúvida entre "interessado" e "outro", classifique como "outro". EXCEÇÃO: se essa "resposta de uma linha" for um nome, e-mail ou contato (não autoresponder, ver regra acima), é "encaminhamento", não "outro" — mandar só o contato, sem explicação, ainda é encaminhar.

Remetente "no-reply"/notificação automática de serviço, ou corpo com conteúdo genérico de marketing/produto sem nenhuma relação com o assunto específico que foi enviado na cadência, é "outro" (spam/notificação), nunca "interessado" — mesmo que o texto pareça conversacional.

Responda APENAS um JSON no formato {"category": "interessado"|"encaminhamento"|"negado"|"outro"}. Nada além disso.
`.trim()

// Chamada crua via fetch (mesmo padrão do backend/src/modules/ai/openaiClient.ts)
// — worker não tem SDK da OpenAI como dependência, só o que já usa em todo canto.
export async function classifyReply(subject: string, body: string): Promise<LeadStatus> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model: CHAT_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 20,
      messages: [
        { role: 'system', content: SYSTEM_INSTRUCTIONS },
        { role: 'user', content: `Assunto: ${subject || '(sem assunto)'}\n\n${(body || '(sem corpo)').slice(0, 6000)}` },
      ],
    }),
  })

  const data: any = await res.json().catch(() => null)
  if (!res.ok) throw new OpenAiError(data?.error?.message || `Erro da OpenAI ao classificar (${res.status})`)

  let category = ''
  try { category = JSON.parse(data?.choices?.[0]?.message?.content ?? '{}')?.category } catch { /* cai no fallback abaixo */ }

  return VALID_STATUSES.includes(category as LeadStatus) ? (category as LeadStatus) : 'outro'
}

const SUMMARY_INSTRUCTIONS = `
Você resume, em 1 linha curta, uma resposta de e-mail classificada como "interessado" numa cadência de prospecção fria. Dado remetente, assunto e corpo, extraia:

- "company": nome curto da empresa do remetente (sem LTDA/S.A./ME e sem artigo), inferido do domínio do e-mail ou da assinatura. Se não der pra inferir com confiança, use string vazia "".
- "note": frase curta (até 8 palavras), começando com verbo no passado (ex: "respondeu sobre X", "pediu mais informações sobre Y", "quer agendar reunião"), descrevendo objetivamente o que a pessoa disse — sem repetir o nome dela, sem ponto final duplicado.

Responda APENAS um JSON no formato {"company": "...", "note": "..."}. Nada além disso.
`.trim()

export async function summarizeInterestedLead(input: {
  fromName: string | null
  fromEmail: string
  subject: string
  body: string
}): Promise<{ company: string; note: string }> {
  const fallback = { company: '', note: 'respondeu ao contato' }
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({
        model: CHAT_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 80,
        messages: [
          { role: 'system', content: SUMMARY_INSTRUCTIONS },
          {
            role: 'user',
            content: `Remetente: ${input.fromName || '(sem nome)'} <${input.fromEmail}>\nAssunto: ${input.subject || '(sem assunto)'}\n\n${(input.body || '(sem corpo)').slice(0, 4000)}`,
          },
        ],
      }),
    })

    const data: any = await res.json().catch(() => null)
    if (!res.ok) throw new OpenAiError(data?.error?.message || `Erro da OpenAI ao resumir (${res.status})`)

    const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? '{}')
    return {
      company: typeof parsed.company === 'string' ? parsed.company.trim() : '',
      note: typeof parsed.note === 'string' && parsed.note.trim() ? parsed.note.trim() : fallback.note,
    }
  } catch {
    // Resumo é enriquecimento cosmético do relatório — se a IA falhar aqui,
    // não pode derrubar o relatório inteiro (classificação já foi salva).
    return fallback
  }
}
