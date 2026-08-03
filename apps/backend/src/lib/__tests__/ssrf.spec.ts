import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('dns/promises', () => ({
  default: { resolve4: vi.fn(), resolve6: vi.fn() },
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}))

import dns from 'dns/promises'
import { isPrivateHost } from '../ssrf'

describe('isPrivateHost', () => {
  beforeEach(() => {
    vi.mocked(dns.resolve4).mockReset()
    vi.mocked(dns.resolve6).mockReset()
  })

  it('bloqueia IPs literais de rede privada/loopback', async () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.1.1']) {
      expect(await isPrivateHost(ip)).toBe(true)
    }
  })

  it('permite IPs literais publicos', async () => {
    expect(await isPrivateHost('8.8.8.8')).toBe(false)
    expect(await isPrivateHost('1.1.1.1')).toBe(false)
  })

  it('bloqueia hostname que resolve pra IP privado (DNS rebinding)', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(['127.0.0.1'])
    vi.mocked(dns.resolve6).mockRejectedValue(new Error('no AAAA'))
    expect(await isPrivateHost('rebind.attacker.example')).toBe(true)
  })

  it('permite hostname que resolve so pra IP publico', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34'])
    vi.mocked(dns.resolve6).mockRejectedValue(new Error('no AAAA'))
    expect(await isPrivateHost('mail.example.com')).toBe(false)
  })

  it('fail-closed: erro de DNS conta como privado', async () => {
    vi.mocked(dns.resolve4).mockRejectedValue(new Error('ENOTFOUND'))
    vi.mocked(dns.resolve6).mockRejectedValue(new Error('ENOTFOUND'))
    expect(await isPrivateHost('nao-existe.invalid')).toBe(true)
  })

  it('fail-closed: zero enderecos resolvidos conta como privado', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue([])
    vi.mocked(dns.resolve6).mockRejectedValue(new Error('no AAAA'))
    expect(await isPrivateHost('sem-endereco.example')).toBe(true)
  })
})
