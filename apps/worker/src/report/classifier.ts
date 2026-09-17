const CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini'

export class OpenAiError extends Error {}

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new OpenAiError('OPENAI_API_KEY não configurada')
  return key
}

export type LeadStatus = 'interessado' | 'apresentacao' | 'encaminhamento' | 'negado' | 'automatico' | 'outro'
const VALID_STATUSES: LeadStatus[] = ['interessado', 'apresentacao', 'encaminhamento', 'negado', 'automatico', 'outro']

const SYSTEM_INSTRUCTIONS = `
Você classifica respostas de e-mail recebidas em resposta a uma cadência de prospecção fria (cold outbound, via Snov.io). Dado o assunto e o corpo do e-mail recebido, classifique em EXATAMENTE uma categoria:

- "interessado": PESSOA real já demonstra avanço concreto — quer agendar conversa/reunião/demo diretamente, discute uma demanda específica, ou dá um próximo passo que não depende da gente mandar nada primeiro. O contato está avançando o processo, não só abrindo a porta.
- "apresentacao": PESSOA demonstra interesse genérico mas o próximo passo depende da GENTE mandar material primeiro (portfólio, catálogo, apresentação institucional, cases) antes de qualquer reunião ou negociação real — ex: "me encaminhe o portfólio e depois alinhamos uma conversa", "pode mandar mais informações que a gente avalia". Sinais: pede material/portfólio/catálogo antes de comprometer uma reunião; fala em "verificar se existe oportunidade" sem compromisso concreto; a bola fica do nosso lado; não há ainda demanda específica, proposta, prazo ou valor discutido — só abertura para conhecer a empresa. NÃO é "interessado" mesmo que o texto seja educado e demonstre abertura, porque falta o material de apresentação ser enviado antes de considerar avanço real.
- "encaminhamento": uma PESSOA, escrevendo ativamente sobre o assunto da cadência, diz que encaminhou ou vai encaminhar a conversa pra outra pessoa/setor (ex: "encaminhei pro responsável", "fale com fulano@empresa.com"), OU o corpo inteiro da resposta é só um nome/e-mail/contato solto (com ou sem assinatura), sem nenhuma frase — sinal de que a pessoa está redirecionando pro contato certo sem escrever explicação (ex: corpo é literalmente "joana@empresa.com" e nada mais, ou "Fulano de Tal, Compras" seguido de assinatura).
- "negado": recusa explícita, diz que não tem interesse, pede pra não receber mais e-mails/remoção da lista.
- "automatico": resposta automática mecânica — SEMPRE "automatico", nunca "interessado" nem "encaminhamento", mesmo quando o texto cita outro nome/e-mail pra redirecionar as mensagens (ex: "estarei ausente até dia X, favor direcionar para fulano@empresa.com", "esta conta foi desativada, encaminhar para fulano@empresa.com", "fulano não faz mais parte da empresa, direcionar para beltrano@empresa.com") ou soa educado/receptivo (ex: "obrigado pelo contato, retornaremos em breve", "recebemos sua mensagem"). Cobre: ausência/férias, fora do escritório, conta desativada, funcionário desligado, caixa cheia, confirmação automática de recebimento/ticket, e qualquer outro autoresponder mecânico. Sinais: texto genérico/padronizado sem relação com o assunto específico enviado, ausência de saudação pessoal, tom impessoal/repetível pra qualquer remetente, menção a "resposta automática"/"esta é uma mensagem automática"/"out of office"/"auto-reply" em qualquer lugar do corpo. Prefixo "[EXTERNO]" no assunto é só uma tag de segurança de e-mail corporativo, não indica nada sobre o conteúdo.
- "outro": qualquer coisa que não se encaixe claramente acima — bounce técnico, newsletter, spam, notificação de serviço, mensagem ambígua, vazia ou sem relação com a cadência (mas que NÃO seja um autoresponder mecânico — isso é "automatico", ver categoria acima).

Também é "outro" (nunca "interessado"): corpo vazio ou quase vazio, respostas de uma linha sem conteúdo real (ex: só "ok", "recebido"), ou qualquer mensagem que não traga nenhum sinal concreto de interesse — na dúvida entre "interessado" e "outro", classifique como "outro". EXCEÇÃO: se essa "resposta de uma linha" for um nome, e-mail ou contato (não autoresponder, ver categoria "automatico"), é "encaminhamento", não "outro" — mandar só o contato, sem explicação, ainda é encaminhar.

Remetente "no-reply"/notificação automática de serviço, ou corpo com conteúdo genérico de marketing/produto sem nenhuma relação com o assunto específico que foi enviado na cadência, é "outro" (spam/notificação), nunca "interessado" — mesmo que o texto pareça conversacional. Isso é diferente de "automatico": "outro" é ruído/spam de terceiros, "automatico" é o PRÓPRIO destinatário da cadência tendo um autoresponder mecânico ativo.

Responda APENAS um JSON no formato {"category": "interessado"|"apresentacao"|"encaminhamento"|"negado"|"automatico"|"outro"}. Nada além disso.
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
Você resume, em 1 linha curta, uma resposta de e-mail classificada como "interessado" ou "apresentacao" numa cadência de prospecção fria. Dado remetente, assunto e corpo, extraia:

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
