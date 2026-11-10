import { describe, it, expect, vi, beforeEach } from 'vitest'

const findLog = vi.fn()
const findConfig = vi.fn()
const updateMany = vi.fn()
const countLogs = vi.fn()
const send = vi.fn()
const suppressed = vi.fn()

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    autoReplyLog: {
      findUnique: (...a: unknown[]) => findLog(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
      update: vi.fn().mockResolvedValue({ id: 'l1', status: 'referral_sent' }),
      count: (...a: unknown[]) => countLogs(...a),
    },
    autoReplyConfig: { findUnique: (...a: unknown[]) => findConfig(...a) },
    mailAccount: { findUnique: vi.fn().mockResolvedValue({ userId: 'u1' }) },
  },
}))
vi.mock('../../ai/openaiClient', () => ({ generateWithInstructions: vi.fn() }))
vi.mock('../../messages/useCases', () => ({ messageUseCases: { send: (...a: unknown[]) => send(...a) } }))
vi.mock('../suppression', () => ({ isSuppressed: (...a: unknown[]) => suppressed(...a) }))

import { mayContainReferral, parseReferralJson, validateReferral, approveReferral, rejectReferral, ReferralError } from '../referral'

const ctx = { body: 'Obrigado. Fale com o João, joao@empresa.com ou (11) 98765-4321.\n\nMaria\nmaria@lead.com (11) 91111-2222', fromEmail: 'maria@lead.com', accountEmail: 'vendas@cliente.com.br' }

describe('detecção de indicação: validação em código', () => {
  it('só consulta o modelo quando o texto sugere indicação', () => {
    expect(mayContainReferral('Quem cuida disso é o João')).toBe(true)
    expect(mayContainReferral('Encaminhei para a Maria')).toBe(true)
    expect(mayContainReferral('Tenho interesse, pode me mandar mais detalhes?')).toBe(false)
  })

  it('lê JSON mesmo dentro de bloco de código e recusa lixo', () => {
    expect(parseReferralJson('```json\n{"indicacao":true}\n```')).toEqual({ indicacao: true })
    expect(parseReferralJson('sem json')).toBeNull()
  })

  it('aceita e-mail que aparece no texto e telefone válido', () => {
    const r = validateReferral({ indicacao: true, nome: 'João', email: 'JOAO@empresa.com', telefone: '(11) 98765-4321' }, ctx)
    expect(r).toMatchObject({ email: 'joao@empresa.com', phone: '(11) 98765-4321', name: 'João' })
  })

  it('recusa e-mail inventado, do próprio remetente, da própria caixa/domínio e de ruído', () => {
    const base = { indicacao: true, nome: 'X', telefone: null }
    expect(validateReferral({ ...base, email: 'inventado@empresa.com' }, ctx)).toBeNull()
    expect(validateReferral({ ...base, email: 'maria@lead.com' }, ctx)).toBeNull()
    expect(validateReferral({ ...base, email: 'vendas@cliente.com.br' }, { ...ctx, body: ctx.body + ' vendas@cliente.com.br' })).toBeNull()
    expect(validateReferral({ ...base, email: 'financeiro@cliente.com.br' }, { ...ctx, body: ctx.body + ' financeiro@cliente.com.br' })).toBeNull()
    expect(validateReferral({ ...base, email: 'noreply@x.com' }, { ...ctx, body: ctx.body + ' noreply@x.com' })).toBeNull()
  })

  it('só telefone: exige dígitos presentes no texto e tamanho plausível', () => {
    expect(validateReferral({ indicacao: true, nome: 'Ana', email: null, telefone: '11 98765-4321' }, ctx)?.phone).toBe('11 98765-4321')
    expect(validateReferral({ indicacao: true, nome: 'Ana', email: null, telefone: '(21) 90000-0000' }, ctx)).toBeNull()
    expect(validateReferral({ indicacao: true, nome: 'Ana', email: null, telefone: '123' }, ctx)).toBeNull()
  })

  it('sem indicação ou sem contato utilizável, devolve null', () => {
    expect(validateReferral({ indicacao: false, email: 'joao@empresa.com' }, ctx)).toBeNull()
    expect(validateReferral({ indicacao: true, nome: 'João', email: null, telefone: null }, ctx)).toBeNull()
    expect(validateReferral(null, ctx)).toBeNull()
  })
})

const pending = { id: 'l1', accountId: 'a1', status: 'referral_pending', referredEmail: 'joao@empresa.com', fromEmail: 'maria@lead.com', subject: 'Reunião', inReplyTo: '<m1@x>', draft: 'Olá João' }

describe('aprovação da indicação', () => {
  beforeEach(() => {
    process.env.AUTOREPLY_ENABLED = 'true'
    for (const m of [findLog, findConfig, updateMany, countLogs, send, suppressed]) m.mockReset()
    findLog.mockResolvedValue(pending)
    findConfig.mockResolvedValue({ mode: 'live', knowledgeAccountId: null, dailyLimit: 30 })
    updateMany.mockResolvedValue({ count: 1 })
    countLogs.mockResolvedValue(0)
    suppressed.mockResolvedValue(false)
    send.mockResolvedValue(undefined)
  })

  it('envia ao indicado com quem indicou em cópia, na mesma conversa', async () => {
    await approveReferral('l1')
    expect(send).toHaveBeenCalledWith('u1', expect.objectContaining({
      accountId: 'a1', to: ['joao@empresa.com'], cc: ['maria@lead.com'], subject: 'Re: Reunião', inReplyTo: '<m1@x>', text: 'Olá João',
    }))
  })

  it('usa o rascunho editado quando enviado', async () => {
    await approveReferral('l1', 'Texto revisado')
    expect(send).toHaveBeenCalledWith('u1', expect.objectContaining({ text: 'Texto revisado' }))
  })

  it('recusa com kill switch desligado, fora de live, indicado descadastrado, teto diário ou já tratada', async () => {
    process.env.AUTOREPLY_ENABLED = 'false'
    await expect(approveReferral('l1')).rejects.toBeInstanceOf(ReferralError)
    process.env.AUTOREPLY_ENABLED = 'true'
    findConfig.mockResolvedValue({ mode: 'test', dailyLimit: 30 })
    await expect(approveReferral('l1')).rejects.toThrow(/live/)
    findConfig.mockResolvedValue({ mode: 'live', knowledgeAccountId: null, dailyLimit: 30 })
    suppressed.mockResolvedValueOnce(true)
    await expect(approveReferral('l1')).rejects.toThrow(/descadastro/)
    countLogs.mockResolvedValue(30)
    await expect(approveReferral('l1')).rejects.toThrow(/Teto/)
    countLogs.mockResolvedValue(0)
    findLog.mockResolvedValue({ ...pending, status: 'referral_sent' })
    await expect(approveReferral('l1')).rejects.toThrow(/pendente/)
    expect(send).not.toHaveBeenCalled()
  })

  it('não envia duas vezes quando outro clique já travou a linha', async () => {
    updateMany.mockResolvedValue({ count: 0 })
    await expect(approveReferral('l1')).rejects.toThrow(/já está sendo enviada/)
    expect(send).not.toHaveBeenCalled()
  })

  it('rejeitar só vale para pendente', async () => {
    await expect(rejectReferral('l1')).resolves.toMatchObject({ status: 'referral_rejected' })
    updateMany.mockResolvedValue({ count: 0 })
    await expect(rejectReferral('l1')).rejects.toBeInstanceOf(ReferralError)
  })
})
