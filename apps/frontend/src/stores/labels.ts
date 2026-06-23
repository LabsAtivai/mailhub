import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../services/api'
import type { MessageSummary } from './mail'

export interface Label {
  id: string
  name: string
  color: string
  messageCount: number
  createdAt: string
}

interface RawLabel {
  id: string
  name: string
  color: string
  messageCount?: number
  _count?: { messages: number }
  createdAt: string
}

function toLabel(raw: RawLabel): Label {
  return {
    id: raw.id,
    name: raw.name || '',
    color: raw.color || '#F47A20',
    messageCount: raw.messageCount ?? raw._count?.messages ?? 0,
    createdAt: raw.createdAt,
  }
}

function sortLabels(arr: Label[]): Label[] {
  return [...arr].sort((a, b) => a.name.localeCompare(b.name))
}

export const useLabelStore = defineStore('labels', () => {
  const labels = ref<Label[]>([])
  const loading = ref(false)

  async function fetchLabels() {
    loading.value = true
    try {
      const { data } = await api.get('/labels')
      if (Array.isArray(data)) {
        labels.value = sortLabels(data.map(toLabel))
      }
    } catch {
      labels.value = []
    } finally {
      loading.value = false
    }
  }

  async function createLabel(name: string, color: string): Promise<Label> {
    const { data } = await api.post('/labels', { name, color })
    const created = toLabel(data)
    labels.value = sortLabels([...labels.value.filter(l => l.id !== created.id), created])
    return created
  }

  async function updateLabel(id: string, name: string, color: string): Promise<void> {
    const { data } = await api.patch(`/labels/${id}`, { name, color })
    labels.value = sortLabels(
      labels.value.map(l => l.id === id ? { ...l, ...toLabel(data) } : l)
    )
  }

  async function deleteLabel(id: string): Promise<void> {
    await api.delete(`/labels/${id}`)
    labels.value = labels.value.filter(l => l.id !== id)
  }

  async function assignLabel(messageId: string, labelId: string): Promise<Label[]> {
    labels.value = labels.value.map(x =>
      x.id === labelId ? { ...x, messageCount: x.messageCount + 1 } : x
    )
    try {
      const { data } = await api.post(`/messages/${messageId}/labels`, { labelId })
      return data
    } catch (err) {
      labels.value = labels.value.map(x =>
        x.id === labelId ? { ...x, messageCount: Math.max(0, x.messageCount - 1) } : x
      )
      throw err
    }
  }

  async function removeLabel(messageId: string, labelId: string): Promise<Label[]> {
    labels.value = labels.value.map(x =>
      x.id === labelId ? { ...x, messageCount: Math.max(0, x.messageCount - 1) } : x
    )
    try {
      const { data } = await api.delete(`/messages/${messageId}/labels/${labelId}`)
      return data
    } catch (err) {
      labels.value = labels.value.map(x =>
        x.id === labelId ? { ...x, messageCount: x.messageCount + 1 } : x
      )
      throw err
    }
  }

  async function fetchLabelMessages(labelId: string, cursor?: string) {
    const params: Record<string, string | number> = { limit: 50 }
    if (cursor) params.cursor = cursor
    const { data } = await api.get(`/labels/${labelId}/messages`, { params })
    return data as { items: MessageSummary[]; nextCursor: string | null; label: Label }
  }

  return {
    labels, loading,
    fetchLabels, createLabel, updateLabel, deleteLabel,
    assignLabel, removeLabel, fetchLabelMessages,
  }
})
