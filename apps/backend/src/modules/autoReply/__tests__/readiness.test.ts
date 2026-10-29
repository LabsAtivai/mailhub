import { describe, it, expect } from 'vitest'
import { scanText } from '../readiness'

describe('readiness scanText', () => {
  it('detecta campos não preenchidos', () => {
    expect(scanText('Contato: (confirmar)').placeholder).toBe(true)
    expect(scanText('Olá, (nome do indicado)!').placeholder).toBe(true)
    expect(scanText('Olá {{first_name:Olá}}').placeholder).toBe(true)
    expect(scanText('Atendemos empresas de todo o Brasil.').placeholder).toBe(false)
  })
  it('detecta CNPJ e credenciais', () => {
    expect(scanText('cnpj 10.886.619/0001-07').cnpj).toBe(true)
    expect(scanText('Ligue (47) 3801-6000').cnpj).toBe(false)
    expect(scanText('PASS,SG.abcdefghij1234567890').secret).toBe(true)
    expect(scanText('senha: abc123').secret).toBe(true)
  })
  it('detecta conteúdo genérico de onboarding', () => {
    expect(scanText('Speed to lead aumenta as chances').generic).toBe(true)
    expect(scanText('Notebooks de alta performance').generic).toBe(false)
  })
})
