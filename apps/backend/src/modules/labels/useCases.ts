import { labelRepository as repo } from './repository'
import { NotFoundError } from '../messages/useCases'

export class ConflictError extends Error {}

export const labelUseCases = {
  async list(userId: string) {
    const labels = await repo.listForUser(userId)
    return labels.map(l => ({
      id: l.id, name: l.name, color: l.color,
      createdAt: l.createdAt, messageCount: l._count.messages,
    }))
  },

  async create(userId: string, name: string, color: string) {
    if (await repo.findByName(userId, name)) throw new ConflictError('Etiqueta com este nome já existe')
    const label = await repo.create(userId, name, color)
    return { ...label, messageCount: 0 }
  },

  async update(id: string, userId: string, data: { name?: string; color?: string }) {
    const label = await repo.findForUser(id, userId)
    if (!label) throw new NotFoundError('Etiqueta não encontrada')
    if (data.name && await repo.findByName(userId, data.name, id)) {
      throw new ConflictError('Nome já em uso')
    }
    return repo.update(id, data)
  },

  async remove(id: string, userId: string) {
    const label = await repo.findForUser(id, userId)
    if (!label) throw new NotFoundError('Etiqueta não encontrada')
    await repo.remove(id)
  },

  async messages(labelId: string, userId: string, limit: number, cursor?: string) {
    const label = await repo.findForUser(labelId, userId)
    if (!label) throw new NotFoundError('Etiqueta não encontrada')
    const rows = await repo.messagesByLabel(labelId, limit, cursor)
    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore
      ? `${items[items.length - 1].date.toISOString()}_${items[items.length - 1].id}`
      : null
    return { items, nextCursor, label }
  },
}
