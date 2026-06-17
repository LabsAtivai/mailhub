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
    await api.post('/labels', { name, color })
    await fetchLabels()
    return labels.value[labels.value.length - 1]
  }

  async function updateLabel(id: string, name: string, color: string): Promise<void> {
    await api.patch(`/labels/${id}`, { name, color })
    await fetchLabels()
  }

  async function deleteLabel(id: string): Promise<void> {
    await api.delete(`/labels/${id}`)
    labels.value = labels.value.filter(l => l.id !== id)
  }

  async function assignLabel(messageId: string, labelId: string): Promise<Label[]> {
    const { data } = await api.post(`/messages/${messageId}/labels`, { labelId })
    await fetchLabels()
    return data
  }

  async function removeLabel(messageId: string, labelId: string): Promise<Label[]> {
    const { data } = await api.delete(`/messages/${messageId}/labels/${labelId}`)
    await fetchLabels()
    return data
  }

  async function fetchLabelMessages(labelId: string, cursor?: string) {
    const params: Record<string, string | number> = { limit: 50 }
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
