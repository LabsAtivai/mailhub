import { messageRepository } from '../messages/repository'
import { clientRepository } from './repository'
import type { UpsertClientProfileDto } from './dto'

export class NotFoundError extends Error {}

async function requireOwnedAccount(accountId: string, userId: string) {
  const account = await messageRepository.findAccountForUser(accountId, userId)
  if (!account) throw new NotFoundError('Conta não encontrada')
  return account
}

export const clientUseCases = {
  async list(accountId: string, userId: string) {
    await requireOwnedAccount(accountId, userId)
    return clientRepository.listByAccount(accountId)
  },

  async upsert(accountId: string, userId: string, dto: UpsertClientProfileDto) {
    await requireOwnedAccount(accountId, userId)
    return clientRepository.upsert(accountId, dto.domain, dto.clientName, dto.content)
  },

  async remove(accountId: string, userId: string, profileId: string) {
    await requireOwnedAccount(accountId, userId)
    const profile = await clientRepository.findByIdForAccount(profileId, accountId)
    if (!profile) throw new NotFoundError('Perfil de cliente não encontrado')
    await clientRepository.remove(profileId)
  },
}
