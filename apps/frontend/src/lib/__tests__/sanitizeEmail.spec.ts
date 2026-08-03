import { describe, it, expect } from 'vitest'
import { sanitizeEmailHtml } from '../sanitizeEmail'

function fetchableUrlsIn(html: string): string[] {
  // remove os atributos diagnósticos data-blocked-* antes de checar --
  // eles guardam a URL original de propósito e não são buscados pelo navegador
  const withoutDiagnostics = html.replace(/\sdata-blocked-[a-z]+="[^"]*"/gi, '')
  return withoutDiagnostics.match(/https?:\/\/tracker\.evil[^\s"')]*/gi) || []
}

describe('sanitizeEmailHtml anti-tracking', () => {
  const vectors: Record<string, string> = {
    'img src': '<img src="https://tracker.evil/pixel.gif">',
    'img srcset': '<img src="" srcset="https://tracker.evil/pixel.gif 1x">',
    'table background': '<table background="https://tracker.evil/pixel.gif"><tr><td>x</td></tr></table>',
    'inline style background-image': '<div style="background-image:url(https://tracker.evil/pixel.gif)">x</div>',
    'style tag content': '<style>body{background:url(https://tracker.evil/pixel.gif)}</style>',
  }

  for (const [name, html] of Object.entries(vectors)) {
    it(`bloqueia ${name} quando imagens remotas estao desativadas`, () => {
      const clean = sanitizeEmailHtml(html, { blockRemoteImages: true })
      expect(fetchableUrlsIn(clean)).toEqual([])
    })
  }

  it('permite imagens remotas quando o usuario ativa explicitamente', () => {
    const clean = sanitizeEmailHtml('<img src="https://tracker.evil/pixel.gif">', { blockRemoteImages: false })
    expect(clean).toContain('https://tracker.evil/pixel.gif')
  })

  it('sempre remove tags perigosas independente do modo de imagem', () => {
    const clean = sanitizeEmailHtml('<script>alert(1)</script><p onclick="alert(2)">oi</p>', { blockRemoteImages: false })
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('onclick')
  })
})
