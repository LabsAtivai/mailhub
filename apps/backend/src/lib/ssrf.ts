import net from 'net'
import dns from 'dns/promises'

const PRIVATE_RANGES = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./, /^169\.254\./, /^224\./, /^240\./,
]

const PRIVATE_IPV6 = [
  /^::1$/, /^::$/, /^fc/i, /^fd/i, /^fe80:/i, /^::ffff:127\./i,
  /^::ffff:10\./i, /^::ffff:192\.168\./i, /^::ffff:172\.(1[6-9]|2\d|3[01])\./i,
]

function isPrivateIP(ip: string): boolean {
  if (net.isIPv4(ip)) return PRIVATE_RANGES.some(r => r.test(ip))
  if (net.isIPv6(ip)) return PRIVATE_IPV6.some(r => r.test(ip))
  return false
}

// Bloqueia cadastro de conta IMAP/SMTP apontando pra rede interna (SSRF).
// Fail-closed: erro de DNS ou zero endereços resolvidos conta como privado.
export async function isPrivateHost(host: string): Promise<boolean> {
  if (net.isIP(host)) return isPrivateIP(host)
  try {
    const [ipv4, ipv6] = await Promise.allSettled([
      dns.resolve4(host),
      dns.resolve6(host),
    ])
    const addrs: string[] = []
    if (ipv4.status === 'fulfilled') addrs.push(...ipv4.value)
    if (ipv6.status === 'fulfilled') addrs.push(...ipv6.value)
    if (addrs.length === 0) return true
    return addrs.some(isPrivateIP)
  } catch {
    return true
  }
}
