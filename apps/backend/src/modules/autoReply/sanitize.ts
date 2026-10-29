// Sanitização de entrada e saída portada do painel AtivaWriter
// (ativawriter-panel/server/openaiClient.js), que por sua vez vem da API de produção.

function normalizeText(text: string): string {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000/g, '')
    .trim()
}

function dedupeLines(text: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of normalizeText(text).split('\n').map(l => l.trim()).filter(Boolean)) {
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out.join('\n')
}

// Remove histórico citado, assinaturas de app e linhas repetidas do e-mail recebido.
export function sanitizeEmailBody(text: string, maxChars: number): string {
  let clean = normalizeText(text)

  const historyPatterns = [
    /\n-{2,}\s*Mensagem encaminhada\s*-{2,}[\s\S]*$/i,
    /\n-{2,}\s*Forwarded message\s*-{2,}[\s\S]*$/i,
    /\nEm\s.+?escreveu:[\s\S]*$/i,
    /\nOn\s.+?wrote:[\s\S]*$/i,
    /\nDe:\s.+[\s\S]*$/i,
    /\nFrom:\s.+[\s\S]*$/i,
  ]
  for (const pattern of historyPatterns) clean = clean.replace(pattern, '')

  clean = clean
    .split('\n')
    .filter(line => !line.trim().startsWith('>'))
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => {
      const lower = line.toLowerCase()
      return !(/^enviado do meu iphone$/i.test(lower) || /^sent from my iphone$/i.test(lower)
        || /^att[,]?$/i.test(lower) || /^best[,]?$/i.test(lower) || /^thanks[,]?$/i.test(lower))
    })
    .join('\n')

  clean = normalizeText(dedupeLines(clean))
  return clean.length > maxChars ? clean.slice(0, maxChars) : clean
}

// Remove rótulos de diagnóstico que o modelo às vezes devolve junto do e-mail.
export function cleanupFinalEmail(text: string): string {
  return normalizeText(text)
    .replace(/^\s*assunto:\s.*$/gim, '')
    .replace(/^\s*classifica[çc][ãa]o:\s.*$/gim, '')
    .replace(/^\s*categoria:\s.*$/gim, '')
    .replace(/^\s*an[áa]lise:\s.*$/gim, '')
    .trim()
}
