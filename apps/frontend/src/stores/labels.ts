import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../services/api'

export interface Label {
  id: string
  name: string
  color: string
  messageCount: number
  createdAt: string
}

export const useLabelStore = defineStore('labels', () => {
  const labels = ref<Label[]>([])
  const loading = ref(false)

  async function fetchLabels() {
    loading.value = true
    try {
      const { data } = await api.get('/labels')
      labels.value = data
    } finally {
      loading.value = false
    }
  }

  async function createLabel(name: string, color: string): Promise<Label> {
    const { data } = await api.post('/labels', { name, color })
    labels.value = [...labels.value, { ...data, messageCount: data.messageCount ?? 0 }]
      .sort((a, b) => a.name.localeCompare(b.name))
    return data
  }

  async function updateLabel(id: string, name: string, color: string): Promise<void> {
    const { data } = await api.patch(`/labels/${id}`, { name, color })
    labels.value = labels.value.map(l => l.id === id ? { ...l, ...data } : l)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async function deleteLabel(id: string): Promise<void> {
    await api.delete(`/labels/${id}`)
    labels.value = labels.value.filter(l => l.id !== id)
  }

  // Routes are now under /messages/:id/labels (no conflict with /labels/:id)
  async function assignLabel(messageId: string, labelId: string): Promise<Label[]> {
    const { data } = await api.post(`/messages/${messageId}/labels`, { labelId })
    const l = labels.value.find(x => x.id === labelId)
    if (l) l.messageCount++
    return data
  }

  async function removeLabel(messageId: string, labelId: string): Promise<Label[]> {
    const { data } = await api.delete(`/messages/${messageId}/labels/${labelId}`)
    const l = labels.value.find(x => x.id === labelId)
    if (l && l.messageCount > 0) l.messageCount--
    return data
  }

  async function fetchLabelMessages(labelId: string, cursor?: string) {
    const params: any = { limit: 50 }
    if (cursor) params.cursor = cursor
    const { data } = await api.get(`/labels/${labelId}/messages`, { params })
    return data as { items: any[]; nextCursor: string | null; label: Label }
  }

  return {
    labels, loading,
    fetchLabels, createLabel, updateLabel, deleteLabel,
    assignLabel, removeLabel, fetchLabelMessages,
  }
})
