import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import { api } from '../services/api'
import { getSocket } from '../services/socket'

export interface MailAccount {
  id: string; displayName: string; emailAddress: string
  syncState: string; lastSyncAt: string | null; lastError: string | null; createdAt: string
}
export interface Folder {
  id: string; path: string; name: string; specialUse: string | null
  unreadCount: number; totalMessages: number
}
export interface MessageSummary {
  id: string; uid: string; subject: string | null; preview: string | null
  fromName: string | null; fromEmail: string | null; toJson: string
  date: string; isRead: boolean; isFlagged: boolean; hasAttachments: boolean; size: number | null
}
export interface MessageDetail extends MessageSummary {
  htmlBody: string | null; textBody: string | null; ccJson: string | null
  inReplyTo: string | null; messageId: string | null
  attachments: Attachment[]; bodyFetching: boolean
  labels: { id: string; name: string; color: string }[]
}
export interface Attachment {
  id: string; filename: string; mimeType: string; size: number
  contentId: string | null; isInline: boolean
}

export const useMailStore = defineStore('mail', () => {
  const accounts = ref<MailAccount[]>([])
  const foldersByAccount = ref<Record<string, Folder[]>>({})
  const selectedAccountId = ref<string | null>(null)
  const selectedFolderId = ref<string | null>(null)
  // shallowRef for large arrays — avoids deep reactive overhead on 1000s of messages
  const messages = shallowRef<MessageSummary[]>([])
  const nextCursor = ref<string | null>(null)
  const selectedMessage = ref<MessageDetail | null>(null)
  const loadingMessages = ref(false)
  const loadingMessage = ref(false)
  const connected = ref(false)
  const searchResults = shallowRef<MessageSummary[]>([])
  const searchQuery = ref('')
  const syncProgress = ref<Record<string, { state: string; progress?: number; currentFolder?: string }>>({})

  // ── accounts ───────────────────────────────────────────────────────────────
  async function fetchAccounts() {
    const { data } = await api.get('/accounts')
    accounts.value = data
    for (const acc of data) {
      await fetchFolders(acc.id)
    }
    // single socket setup call — not per-account
    setupSocket(data.map((a: MailAccount) => a.id))

    // auto-select INBOX of first account
    if (data.length > 0 && !selectedFolderId.value) {
      const firstFolders = foldersByAccount.value[data[0].id] ?? []
      const inbox = firstFolders.find(
        (f: Folder) => f.specialUse === '\\Inbox' || f.path === 'INBOX' || f.name.toLowerCase() === 'inbox'
      )
      if (inbox) selectFolder(data[0].id, inbox.id)
    }
  }

  async function fetchFolders(accountId: string) {
    const { data } = await api.get(`/accounts/${accountId}/folders`)
    foldersByAccount.value = { ...foldersByAccount.value, [accountId]: data }
  }

  // ── folder / messages ──────────────────────────────────────────────────────
  async function selectFolder(accountId: string, folderId: string) {
    selectedAccountId.value = accountId
    selectedFolderId.value = folderId
    selectedMessage.value = null
    searchQuery.value = ''
    searchResults.value = []
    messages.value = []
    nextCursor.value = null
    await loadMessages()
  }

  async function loadMessages(append = false) {
    if (!selectedFolderId.value) return
    loadingMessages.value = true
    try {
      const params: any = { limit: 50 }
      if (append && nextCursor.value) params.cursor = nextCursor.value
      const { data } = await api.get(`/folders/${selectedFolderId.value}/messages`, { params })
      messages.value = append ? [...messages.value, ...data.items] : data.items
      nextCursor.value = data.nextCursor
    } finally {
      loadingMessages.value = false
    }
  }

  // ── search ─────────────────────────────────────────────────────────────────
  async function search(q: string) {
    searchQuery.value = q
    if (!q.trim()) { searchResults.value = []; return }
    const { data } = await api.get('/messages/search', { params: { q } })
    searchResults.value = data.items
  }

  // ── message detail ─────────────────────────────────────────────────────────
  async function selectMessage(id: string) {
    loadingMessage.value = true
    selectedMessage.value = null
    try {
      const { data } = await api.get(`/messages/${id}`)
      selectedMessage.value = data

      // mark read optimistically in list
      const target = messages.value.find(x => x.id === id)
        || searchResults.value.find(x => x.id === id)
      if (target && !target.isRead) {
        // mutate a shallow copy to trigger shallowRef update
        messages.value = messages.value.map(m => m.id === id ? { ...m, isRead: true } : m)
        api.patch(`/messages/${id}`, { isRead: true })
        updateFolderUnread(data.folderId, -1)
      }
    } finally {
      loadingMessage.value = false
    }
  }

  async function refreshMessage(id: string) {
    if (!selectedMessage.value || selectedMessage.value.id !== id) return
    const { data } = await api.get(`/messages/${id}`)
    selectedMessage.value = data
  }

  // ── mutations ──────────────────────────────────────────────────────────────
  async function toggleFlag(id: string, isFlagged: boolean) {
    messages.value = messages.value.map(m => m.id === id ? { ...m, isFlagged } : m)
    searchResults.value = searchResults.value.map(m => m.id === id ? { ...m, isFlagged } : m)
    if (selectedMessage.value?.id === id) selectedMessage.value = { ...selectedMessage.value, isFlagged }
    await api.patch(`/messages/${id}`, { isFlagged })
  }

  async function deleteMessage(id: string) {
    await api.delete(`/messages/${id}`)
    messages.value = messages.value.filter(x => x.id !== id)
    searchResults.value = searchResults.value.filter(x => x.id !== id)
    if (selectedMessage.value?.id === id) selectedMessage.value = null
  }

  function updateFolderUnread(folderId: string, delta: number) {
    const updated = { ...foldersByAccount.value }
    for (const [accId, folders] of Object.entries(updated)) {
      const idx = folders.findIndex(f => f.id === folderId)
      if (idx !== -1) {
        const newFolders = [...folders]
        newFolders[idx] = { ...newFolders[idx], unreadCount: Math.max(0, newFolders[idx].unreadCount + delta) }
        updated[accId] = newFolders
        break
      }
    }
    foldersByAccount.value = updated
  }

  // ── label view ─────────────────────────────────────────────────────────────
  async function loadLabelMessages(labelId: string, items: any[], cursor: string | null) {
    selectedFolderId.value = null
    selectedAccountId.value = null
    selectedMessage.value = null
    searchQuery.value = ''
    searchResults.value = []
    messages.value = items
    nextCursor.value = cursor
  }

  // ── socket setup — called ONCE with all account IDs ────────────────────────
  let socketInitialized = false

  function setupSocket(accountIds: string[]) {
    if (socketInitialized) {
      // just join new rooms
      const socket = getSocket()
      for (const id of accountIds) socket.emit('join:account', id)
      return
    }
    socketInitialized = true

    const socket = getSocket()
    connected.value = socket.connected

    socket.on('connect', () => {
      connected.value = true
      // re-join all rooms after reconnect
      for (const id of accounts.value.map(a => a.id)) {
        socket.emit('join:account', id)
      }
    })
    socket.on('disconnect', () => { connected.value = false })

    for (const id of accountIds) socket.emit('join:account', id)

    // ── mail events ──────────────────────────────────────────────────────────
    socket.on('mail:new', (payload: any) => {
      if (payload.folderId === selectedFolderId.value) {
        const exists = messages.value.some(x => x.id === payload.messageId)
        if (!exists) {
          messages.value = [{
            id: payload.messageId, uid: '', subject: payload.subject ?? null,
            preview: null, fromName: payload.fromName ?? null, fromEmail: payload.fromEmail ?? null,
            toJson: '[]', date: new Date().toISOString(),
            isRead: false, isFlagged: false, hasAttachments: false, size: null,
          }, ...messages.value]
        }
      }
      updateFolderUnread(payload.folderId, 1)
    })

    socket.on('mail:bodyReady', (payload: any) => {
      if (selectedMessage.value?.id === payload.messageId) {
        refreshMessage(payload.messageId)
      }
    })

    socket.on('mail:updated', (payload: any) => {
      const patch = (m: MessageSummary): MessageSummary => {
        const wasRead = m.isRead
        const isRead = typeof payload.isRead === 'boolean' ? payload.isRead : m.isRead
        const isFlagged = typeof payload.isFlagged === 'boolean' ? payload.isFlagged : m.isFlagged
        if (isRead !== wasRead) updateFolderUnread(selectedFolderId.value!, isRead ? -1 : 1)
        return { ...m, isRead, isFlagged }
      }
      if (messages.value.some(m => m.id === payload.messageId)) {
        messages.value = messages.value.map(m => m.id === payload.messageId ? patch(m) : m)
      }
      if (searchResults.value.some(m => m.id === payload.messageId)) {
        searchResults.value = searchResults.value.map(m => m.id === payload.messageId ? patch(m) : m)
      }
      if (selectedMessage.value?.id === payload.messageId) {
        selectedMessage.value = { ...selectedMessage.value, ...payload }
      }
    })

    socket.on('mail:deleted', (payload: any) => {
      messages.value = messages.value.filter(x => x.id !== payload.messageId)
      searchResults.value = searchResults.value.filter(x => x.id !== payload.messageId)
      if (selectedMessage.value?.id === payload.messageId) selectedMessage.value = null
    })

    socket.on('folder:counts', (payload: any) => {
      const updated = { ...foldersByAccount.value }
      for (const [accId, folders] of Object.entries(updated)) {
        const idx = folders.findIndex(f => f.id === payload.folderId)
        if (idx !== -1) {
          const newFolders = [...folders]
          newFolders[idx] = {
            ...newFolders[idx],
            unreadCount: payload.unreadCount,
            totalMessages: payload.totalMessages ?? newFolders[idx].totalMessages,
          }
          updated[accId] = newFolders
          break
        }
      }
      foldersByAccount.value = updated
    })

    socket.on('account:syncState', (payload: any) => {
      accounts.value = accounts.value.map(a =>
        a.id === payload.accountId ? { ...a, syncState: payload.state } : a
      )
      syncProgress.value = {
        ...syncProgress.value,
        [payload.accountId]: { state: payload.state, progress: payload.progress, currentFolder: payload.currentFolder }
      }
      if (payload.state === 'IDLE') fetchFolders(payload.accountId)
    })
  }

  return {
    accounts, foldersByAccount, selectedAccountId, selectedFolderId,
    messages, nextCursor, selectedMessage, searchResults, searchQuery,
    loadingMessages, loadingMessage, connected, syncProgress,
    fetchAccounts, fetchFolders, selectFolder, loadMessages,
    selectMessage, refreshMessage, toggleFlag, deleteMessage,
    search, loadLabelMessages,
  }
})
