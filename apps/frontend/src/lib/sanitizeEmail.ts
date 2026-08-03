import DOMPurify from 'dompurify'

const isRemoteUrl = (val: string) => /https?:/i.test(val)
const stripRemoteCssUrls = (css: string) => css.replace(/url\(\s*(['"]?)\s*(https?:)/gi, 'url($1blocked:')

export function sanitizeEmailHtml(html: string, opts: { blockRemoteImages: boolean }): string {
  const cfg: Record<string, unknown> = {
    FORBID_TAGS: ['script', 'iframe', 'form', 'input', 'object', 'embed'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus'],
  }
  if (opts.blockRemoteImages) {
    // Bloquear só img[src] deixava passar srcset, o atributo "background"
    // (tabelas/body em HTML de e-mail antigo) e background-image:url() tanto
    // em style="" inline quanto dentro de <style> — qualquer um desses
    // carrega o pixel de rastreamento mesmo com o aviso de bloqueio ativo.
    DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
      if (data.attrName === 'src' && node.tagName === 'IMG' && data.attrValue && isRemoteUrl(data.attrValue)) {
        node.setAttribute('data-blocked-src', data.attrValue)
        node.setAttribute('alt', node.getAttribute('alt') || '[imagem bloqueada]')
        data.attrValue = ''
      }
      if (data.attrName === 'srcset' && (node.tagName === 'IMG' || node.tagName === 'SOURCE') && data.attrValue) {
        node.setAttribute('data-blocked-srcset', data.attrValue)
        data.attrValue = ''
      }
      if (data.attrName === 'background' && data.attrValue && isRemoteUrl(data.attrValue)) {
        node.setAttribute('data-blocked-background', data.attrValue)
        data.attrValue = ''
      }
      if (data.attrName === 'style' && data.attrValue) {
        data.attrValue = stripRemoteCssUrls(data.attrValue)
      }
    })
    DOMPurify.addHook('uponSanitizeElement', (node, data) => {
      if (data.tagName === 'style' && node.textContent) {
        node.textContent = stripRemoteCssUrls(node.textContent)
      }
    })
  }
  const clean = DOMPurify.sanitize(html, cfg)
  DOMPurify.removeAllHooks()
  return clean
}
