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

- "interessado": demonstra interesse real no que foi oferecido, pede mais informação, quer agendar conversa/reunião/demo.
- "encaminhamento": indica outra pessoa, setor ou contato pra continuar a conversa (ex: "encaminhei pro responsável", "fale com fulano@empresa.com").
- "negado": recusa explícita, diz que não tem interesse, pede pra não receber mais e-mails/remoção da lista.
- "outro": qualquer coisa que não se encaixe claramente acima — resposta automática/fora do escritório, bounce, newsletter, spam, mensagem ambígua ou sem relação com a cadência.

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
