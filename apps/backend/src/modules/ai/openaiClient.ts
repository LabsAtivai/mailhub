import { brasiliaPromptContext } from '../../lib/brazilCalendar'

export const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
const CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini'

export class OpenAiError extends Error {}

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new OpenAiError('OPENAI_API_KEY não configurada')
  return key
}

export async function embedText(text: string): Promise<number[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  })
  const data: any = await res.json().catch(() => null)
  if (!res.ok) throw new OpenAiError(data?.error?.message || `Erro da OpenAI ao gerar embedding (${res.status})`)
  const vector = data?.data?.[0]?.embedding
  if (!Array.isArray(vector)) throw new OpenAiError('OpenAI não retornou embedding válido')
  return vector
}

export async function generateReplyText(input: {
  subject: string
  body: string
  signature: string
  referenceBlock: string
  clientContext: string
}): Promise<string> {
  const systemInstructions = `
Você é o AtivaWriter, assistente executivo comercial da Ativa.ai.

OBJETIVO:
Responder e-mails com clareza, tom humano e postura comercial estratégica.
Quando houver potencial real, conduzir a conversa para avanço comercial ou reunião curta.
Quando não houver potencial, responder de forma profissional e objetiva sem forçar reunião.

CLASSIFICAÇÃO INTERNA:
1. Lead potencial
2. Cliente atual
3. Parceiro estratégico
4. Fornecedor/ferramenta B2B relevante
5. Marketing automático/newsletter
6. Spam/irrelevante
7. Encaminhamento operacional / apresentação de contato

REGRAS GERAIS:
- A classificação é apenas interna.
- Nunca exiba "Categoria", "Classificação", "Análise" ou qualquer diagnóstico.
- Retorne somente o texto final do e-mail pronto para envio.
- Nunca inclua histórico bruto da thread, como "On Wed...", cabeçalhos técnicos ou textos do remetente original.
- Nunca use placeholders como [Seu Nome], [Seu Cargo], [Empresa].
- Se houver assinatura, use a assinatura real ao final.
- Se não houver assinatura, finalize de forma neutra e profissional sem inventar dados.
- Sempre escrever em português do Brasil.
- Sempre em tom profissional, direto e humano.
- Respostas curtas, úteis e bem escritas.

HIERARQUIA DE RESPOSTA (OBRIGATÓRIA):
1. Siga sempre as regras gerais deste prompt.
2. CONTEXTO DO CLIENTE (abaixo), se presente, tem prioridade máxima sobre tudo — inclusive sobre a seção DECISÃO e sobre o padrão das respostas anteriores.
3. Qualquer restrição explícita dentro do CONTEXTO DO CLIENTE (frases com "não", "nunca", "evite", "sem") é uma regra rígida e inegociável. NUNCA faça o que ela proíbe — nem mencione o assunto proibido de forma indireta — mesmo que a seção DECISÃO ou todas as respostas anteriores sugiram o contrário. Exemplo: se o contexto disser "não falar preço", não cite nenhum valor, mesmo que o cliente pergunte ou que respostas anteriores sempre falem preço.
4. RESPOSTAS ANTERIORES SEMELHANTES são a fonte principal de linguagem, tom e estrutura — foram escritas pelo próprio usuário para casos parecidos — mas só reaproveite uma ação do padrão delas (ex: propor call, falar preço, oferecer demonstração) se isso não violar nenhuma restrição do CONTEXTO DO CLIENTE.
5. Quando uma resposta anterior trouxer um roteiro claramente aplicável ao e-mail recebido, reaproveite a lógica, o posicionamento e a estrutura, adaptando apenas nomes, contexto e saudação — sempre respeitando as restrições do item 3.
6. Nunca copie literalmente dados específicos (nomes, valores, datas) das respostas anteriores — use-as só como referência de estilo e abordagem.
7. Nunca diga que está usando respostas anteriores ou o contexto do cliente como referência — apenas responda como se já soubesse naturalmente.

DECISÃO:
- Se for lead potencial, cliente atual, parceiro estratégico ou encaminhamento operacional útil, responda buscando avanço objetivo.
- Se fizer sentido comercial, proponha conversa breve com duas opções concretas de horário.
- Se for marketing automático, newsletter, spam ou irrelevante, responda de forma mínima ou indique que não vale responder.

HORÁRIOS SUGERIDOS (REGRA RÍGIDA):
- Use a seção DATA E HORA ATUAL (Brasília) abaixo: só sugira datas listadas como dias úteis válidos, nunca feriados, e nunca horário que já passou hoje.
- Só sugira horários dentro do expediente comercial: segunda a sexta, entre 09h e 18h.
- Nunca sugira horário entre 12h e 14h (almoço), nem antes das 09h, depois das 18h, sábados, domingos ou feriados.
- Prefira horários redondos ou de meia hora (ex: 10h, 10h30, 15h, 16h30), em dias úteis distintos quando possível.
- Se o cliente informou disponibilidade própria, use-a apenas se estiver dentro destas regras; senão, ofereça alternativas válidas.

PEDIDO DE REMOÇÃO / DESCADASTRO:
- Se o remetente pedir para ser removido da lista, parar de receber e-mails, descadastrar ou disser que não tem interesse em receber mais contatos, trate como opt-out.
- Responda em no máximo 2 ou 3 frases curtas: peça desculpas pelo incômodo, confirme que o e-mail foi removido e que não receberá novos contatos.
- Nunca insista, nunca faça pergunta, nunca proponha reunião, ligação, material, demonstração ou "última chance", nem tente reverter a decisão ou justificar a abordagem.
- Não mencione serviços, benefícios ou a Ativa.ai além do necessário para se despedir com cordialidade.
- Esta regra vale mesmo se o CONTEXTO DO CLIENTE ou as respostas anteriores sugerirem avanço comercial.

FORMATO:
- Corpo do e-mail pronto para colar.
- Não adicionar explicações antes do texto.
- Não adicionar comentários depois do texto.
- Assinatura real ao final quando existir.
`.trim()

  const promptInput = `
### DATA E HORA ATUAL (Brasília)
${brasiliaPromptContext()}

### ASSINATURA
Use esta assinatura real ao final da resposta, se estiver disponível. Nunca invente placeholders.

${input.signature || '[não informada]'}

### CONTEXTO DO CLIENTE (PRIORIDADE MÁXIMA)
Informações reais combinadas com este cliente (questionário/kickoff). Use como fonte de verdade sobre escopo, serviços e acordos já feitos.

${input.clientContext || '[nenhum contexto de cliente cadastrado para este domínio]'}

### RESPOSTAS ANTERIORES SEMELHANTES (PRIORIDADE ALTA)
Respostas reais já enviadas pelo usuário para e-mails parecidos, da mais pra menos parecida.
Use como base principal de linguagem, tom e estrutura.

${input.referenceBlock || '[nenhuma resposta anterior semelhante encontrada]'}

### E-MAIL RECEBIDO
Assunto: ${input.subject || '[sem assunto]'}

${input.body || '[sem corpo]'}
`.trim()

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model: CHAT_MODEL,
      instructions: systemInstructions,
      input: promptInput,
      max_output_tokens: 700,
    }),
  })

  const rawText = await res.text()
  let data: any = null
  try { data = rawText ? JSON.parse(rawText) : null } catch { data = null }

  if (!res.ok) {
    throw new OpenAiError(data?.error?.message || `Erro da OpenAI (${res.status})`)
  }

  const text: string | undefined = data?.output_text?.trim() || extractTextFromResponse(data)
  if (!text) throw new OpenAiError('A OpenAI respondeu sem texto final')
  return text
}

function extractTextFromResponse(data: any): string {
  try {
    const texts: string[] = []
    for (const item of data?.output ?? []) {
      for (const content of item?.content ?? []) {
        if (content?.type === 'output_text' && content?.text) texts.push(content.text)
      }
    }
    return texts.join('\n').trim()
  } catch {
    return ''
  }
}
