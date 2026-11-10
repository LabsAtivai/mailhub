// Detecção simples do idioma do e-mail recebido. O modelo, sozinho, tende a responder em português
// quando o restante do prompt está em português; por isso o idioma vai explícito no pedido.
export type Lang = 'pt' | 'en' | 'es' | 'unknown'

const WORDS: Record<Exclude<Lang, 'unknown'>, string[]> = {
  pt: ['de', 'que', 'não', 'nao', 'para', 'com', 'uma', 'você', 'voce', 'vocês', 'voces', 'obrigado', 'obrigada', 'olá', 'ola', 'bom', 'dia',
    'boa', 'tarde', 'estou', 'fale', 'falar', 'atenciosamente', 'favor', 'nós', 'nosso', 'nossa', 'empresa', 'sobre', 'seu', 'sua', 'também', 'tenho', 'pode', 'podem', 'quem', 'isso', 'esse', 'essa', 'ele', 'ela'],
  en: ['the', 'and', 'you', 'your', 'for', 'with', 'please', 'thanks', 'thank', 'are', 'we', 'our', 'is', 'to', 'of', 'that', 'this', 'have',
    'can', 'would', 'hi', 'hello', 'regards', 'talk', 'about', 'handles', 'he', 'she', 'do', 'does', 'reaching', 'out', 'me', 'my', 'any', 'how', 'what', 'when', 'will'],
  es: ['el', 'los', 'las', 'para', 'con', 'una', 'usted', 'ustedes', 'gracias', 'hola', 'buenos', 'buenas', 'estimado', 'saludos', 'nuestro',
    'nuestra', 'empresa', 'sobre', 'tengo', 'puede', 'pueden', 'quien', 'eso', 'esta', 'está', 'favor', 'también'],
}

export function detectLanguage(text: string): Lang {
  const words = text.toLowerCase().slice(0, 3000).match(/[a-zà-ú]+/g) ?? []
  if (words.length < 4) return 'unknown'
  const score = { pt: 0, en: 0, es: 0 }
  for (const w of words) {
    for (const l of ['pt', 'en', 'es'] as const) if (WORDS[l].includes(w)) score[l]++
  }
  const ranked = (Object.entries(score) as Array<[Lang, number]>).sort((a, b) => b[1] - a[1])
  const [best, second] = ranked
  if (best[1] < 3 || best[1] < second[1] * 1.5) return 'unknown'
  return best[0]
}

const NAMES: Record<string, string> = { en: 'inglês', es: 'espanhol' }

// Só devolve diretiva quando o idioma não é português: o padrão do agente já é português do Brasil.
export function languageDirective(lang: Lang): string {
  const name = NAMES[lang]
  if (!name) return ''
  return `### IDIOMA DA RESPOSTA (OBRIGATÓRIO)
O remetente escreveu em ${name}. Escreva TODA a resposta em ${name}, da saudação ao fecho, inclusive a linha de descadastro, se houver. Não use português no texto. Traduza de forma natural o que usar do CONTEXTO DO CLIENTE, e mantenha a assinatura exatamente como informada.`
}
