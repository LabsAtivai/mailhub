import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import { api } from '../services/api'
import { getSocket, isSocketInitialized, setSocketInitialized } from '../services/socket'

export interface MailAccount {
  id: string; displayName: string; emailAddress: string
  incomingHost: string; incomingPort: number
  outgoingHost: string; outgoingPort: number
  username: string; tlsMode: string
  syncState: string; lastSyncAt: string | null; lastError: string | null; createdAt: string
  forwardEnabled: boolean; forwardTo: string | null
}
export interface Folder {
  id: string; path: string; name: string; specialUse: string | null
  unreadCount: number; totalMessages: number
}
export interface MessageSummary {
  id: string; uid: string; subject: string | null; preview: string | null
  fromName: string | null; fromEmail: string | null; toJson: string
  date: string; isRead: boolean; isFlagged: boolean; isAnswered: boolean; hasAttachments: boolean; size: number | null
  inReplyTo: string | null
  labels: { id: string; name: string; color: string }[]
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
  const messages = shallowRef<MessageSummary[]>([])
  const nextCursor = ref<string | null>(null)
  const selectedMessage = ref<MessageDetail | null>(null)
  const selectedIds = ref<Set<string>>(new Set())
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
    setupSocket(data.map((a: MailAccount) => a.id))

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

  async function refreshAccount(accountId: string) {
    await api.post(`/accounts/${accountId}/sync`)
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
    clearSelection()
    await loadMessages()
  }

  // ── multi-select (ações em lote) ─────────────────────────────────────────────
  function toggleSelectMessage(id: string) {
    const next = new Set(selectedIds.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selectedIds.value = next
  }

  function selectAllMessages(ids: string[]) {
    selectedIds.value = new Set(ids)
  }

  function clearSelection() {
    selectedIds.value = new Set()
  }

  async function bulkMarkRead(ids: string[], isRead: boolean) {
    // só chama toggleRead para quem realmente muda de estado -- evita
    // inflar/descontar o contador de não lidos da pasta em duplicidade
    const targets = ids.filter(id => {
      const m = messages.value.find(x => x.id === id) || searchResults.value.find(x => x.id === id)
      return m ? m.isRead !== isRead : true
    })
    await Promise.all(targets.map(id => toggleRead(id, isRead)))
  }

  async function bulkDelete(ids: string[]) {
    await Promise.all(ids.map(id => deleteMessage(id).catch(() => {})))
    clearSelection()
  }

  async function loadMessages(append = false) {
    if (!selectedFolderId.value) return
    loadingMessages.value = true
    try {
      const params: Record<string, unknown> = { limit: 50 }
      if (append && nextCursor.value) params.cursor = nextCursor.value
      const { data } = await api.get(`/folders/${selectedFolderId.value}/messages`, { params })
      messages.value = append ? [...messages.value, ...data.items] : data.items
      nextCursor.value = data.nextCursor
    } catch {
      // keep existing messages on error
    } finally {
      loadingMessages.value = false
    }
  }

  // ── search ─────────────────────────────────────────────────────────────────
  async function search(q: string) {
    searchQuery.value = q
    clearSelection()
    if (!q.trim()) { searchResults.value = []; return }
    try {
      const { data } = await api.get('/messages/search', { params: { q } })
      searchResults.value = data.items
    } catch {
      searchResults.value = []
    }
  }

  // ── message detail ─────────────────────────────────────────────────────────
  async function selectMessage(id: string) {
    loadingMessage.value = true
    selectedMessage.value = null
    try {
      const { data } = await api.get(`/messages/${id}`)
      selectedMessage.value = data

      const target = messages.value.find(x => x.id === id)
        || searchResults.value.find(x => x.id === id)
      if (target && !target.isRead) {
        messages.value = messages.value.map(m => m.id === id ? { ...m, isRead: true } : m)
        api.patch(`/messages/${id}`, { isRead: true }).catch(() => {})
        updateFolderUnread(data.folderId, -1)
      }
    } finally {
      loadingMessage.value = false
    }
  }

  async function refreshMessage(id: string) {
    if (!selectedMessage.value || selectedMessage.value.id !== id) return
    try {
      const { data } = await api.get(`/messages/${id}`)
      selectedMessage.value = data
    } catch {
      // keep existing message on error
    }
  }

  // ── mutations ──────────────────────────────────────────────────────────────
  async function toggleFlag(id: string, isFlagged: boolean) {
    messages.value = messages.value.map(m => m.id === id ? { ...m, isFlagged } : m)
    searchResults.value = searchResults.value.map(m => m.id === id ? { ...m, isFlagged } : m)
    if (selectedMessage.value?.id === id) selectedMessage.value = { ...selectedMessage.value, isFlagged }
    try {
      await api.patch(`/messages/${id}`, { isFlagged })
    } catch {
      messages.value = messages.value.map(m => m.id === id ? { ...m, isFlagged: !isFlagged } : m)
      searchResults.value = searchResults.value.map(m => m.id === id ? { ...m, isFlagged: !isFlagged } : m)
      if (selectedMessage.value?.id === id) selectedMessage.value = { ...selectedMessage.value, isFlagged: !isFlagged }
    }
  }

  async function toggleRead(id: string, isRead: boolean) {
    const prevMessages = messages.value
    const prevSearch = searchResults.value
    const prevSelected = selectedMessage.value
    messages.value = messages.value.map(m => m.id === id ? { ...m, isRead } : m)
    searchResults.value = searchResults.value.map(m => m.id === id ? { ...m, isRead } : m)
    if (selectedMessage.value?.id === id) selectedMessage.value = { ...selectedMessage.value, isRead }
    if (selectedFolderId.value) updateFolderUnread(selectedFolderId.value, isRead ? -1 : 1)
    try {
      await api.patch(`/messages/${id}`, { isRead })
    } catch {
      messages.value = prevMessages
      searchResults.value = prevSearch
      selectedMessage.value = prevSelected
      if (selectedFolderId.value) updateFolderUnread(selectedFolderId.value, isRead ? 1 : -1)
    }
  }

  async function deleteMessage(id: string) {
    await api.delete(`/messages/${id}`)
    messages.value = messages.value.filter(x => x.id !== id)
    searchResults.value = searchResults.value.filter(x => x.id !== id)
    if (selectedMessage.value?.id === id) selectedMessage.value = null
    if (selectedIds.value.has(id)) {
      const next = new Set(selectedIds.value)
      next.delete(id)
      selectedIds.value = next
    }
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
  async function loadLabelMessages(_labelId: string, items: MessageSummary[], cursor: string | null) {
    selectedFolderId.value = null
    selectedAccountId.value = null
    selectedMessage.value = null
    searchQuery.value = ''
    searchResults.value = []
    messages.value = items
    nextCursor.value = cursor
    clearSelection()
  }

  // ── socket setup — called ONCE with all account IDs ────────────────────────
  function setupSocket(accountIds: string[]) {
    if (isSocketInitialized()) {
      const socket = getSocket()
      for (const id of accountIds) socket.emit('join:account', id)
      return
    }
    setSocketInitialized(true)

    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission()
    }

    const socket = getSocket()
    connected.value = socket.connected

    socket.on('connect', () => {
      connected.value = true
      for (const id of accounts.value.map(a => a.id)) {
        socket.emit('join:account', id)
      }
    })
    socket.on('disconnect', () => { connected.value = false })

    for (const id of accountIds) socket.emit('join:account', id)

    // ── mail events ──────────────────────────────────────────────────────────
    socket.on('mail:new', (payload: { messageId: string; folderId: string; subject?: string; fromName?: string; fromEmail?: string; inReplyTo?: string | null; selfSent?: boolean }) => {
      if (payload.folderId === selectedFolderId.value) {
        const exists = messages.value.some(x => x.id === payload.messageId)
        if (!exists) {
          messages.value = [{
            id: payload.messageId, uid: '', subject: payload.subject ?? null,
            preview: null, fromName: payload.fromName ?? null, fromEmail: payload.fromEmail ?? null,
            toJson: '[]', date: new Date().toISOString(),
            isRead: !!payload.selfSent, isFlagged: false, isAnswered: false, hasAttachments: false, size: null,
            inReplyTo: payload.inReplyTo ?? null, labels: [],
          }, ...messages.value]
        }
      }
      // Cópia do próprio envio aparecendo na Sent: já nasce lida, não conta
      // como não-lida nem dispara notificação de desktop (não é e-mail novo
      // recebido, é o destino correto do que a gente mesmo mandou).
      if (payload.selfSent) return
      updateFolderUnread(payload.folderId, 1)

      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
        const n = new Notification(payload.fromName || payload.fromEmail || 'Novo email', {
          body: payload.subject || '(sem assunto)',
          icon: '/favicon.ico',
          tag: payload.messageId,
        })
        n.onclick = () => { window.focus(); n.close() }
      }
    })

    socket.on('mail:bodyReady', (payload: { messageId: string }) => {
      if (selectedMessage.value?.id === payload.messageId) {
        refreshMessage(payload.messageId)
      }
    })

    socket.on('mail:updated', (payload: { messageId: string; isRead?: boolean; isFlagged?: boolean; isAnswered?: boolean }) => {
      const patch = (m: MessageSummary): MessageSummary => {
        const wasRead = m.isRead
        const isRead = typeof payload.isRead === 'boolean' ? payload.isRead : m.isRead
        const isFlagged = typeof payload.isFlagged === 'boolean' ? payload.isFlagged : m.isFlagged
        const isAnswered = typeof payload.isAnswered === 'boolean' ? payload.isAnswered : m.isAnswered
        if (isRead !== wasRead && selectedFolderId.value) {
          updateFolderUnread(selectedFolderId.value, isRead ? -1 : 1)
        }
        return { ...m, isRead, isFlagged, isAnswered }
      }
      if (messages.value.some(m => m.id === payload.messageId)) {
        messages.value = messages.value.map(m => m.id === payload.messageId ? patch(m) : m)
      }
      if (searchResults.value.some(m => m.id === payload.messageId)) {
        searchResults.value = searchResults.value.map(m => m.id === payload.messageId ? patch(m) : m)
      }
      if (selectedMessage.value?.id === payload.messageId) {
        // NUNCA espalhar "payload" inteiro aqui: o payload do socket usa
        // "messageId" pra dizer QUAL mensagem (o id interno), enquanto
        // selectedMessage.messageId é o Message-ID de e-mail (RFC822) — um
        // spread cego sobrescrevia esse campo com o id interno, corrompendo
        // o threading de resposta (In-Reply-To/References) e o "Respondido"
        // automático depois de qualquer marca de lido/favorito via socket.
        const m = selectedMessage.value
        selectedMessage.value = {
          ...m,
          isRead: typeof payload.isRead === 'boolean' ? payload.isRead : m.isRead,
          isFlagged: typeof payload.isFlagged === 'boolean' ? payload.isFlagged : m.isFlagged,
          isAnswered: typeof payload.isAnswered === 'boolean' ? payload.isAnswered : m.isAnswered,
        }
      }
    })

    socket.on('mail:deleted', (payload: { messageId: string }) => {
      messages.value = messages.value.filter(x => x.id !== payload.messageId)
      searchResults.value = searchResults.value.filter(x => x.id !== payload.messageId)
      if (selectedMessage.value?.id === payload.messageId) selectedMessage.value = null
      if (selectedIds.value.has(payload.messageId)) {
        const next = new Set(selectedIds.value)
        next.delete(payload.messageId)
        selectedIds.value = next
      }
    })

    socket.on('folder:counts', (payload: { folderId: string; unreadCount: number; totalMessages?: number }) => {
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

    socket.on('account:syncState', (payload: { accountId: string; state: string; progress?: number; currentFolder?: string }) => {
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
    messages, nextCursor, selectedMessage, selectedIds, searchResults, searchQuery,
    loadingMessages, loadingMessage, connected, syncProgress,
    fetchAccounts, fetchFolders, refreshAccount, selectFolder, loadMessages,
    selectMessage, refreshMessage, toggleFlag, toggleRead, deleteMessage,
    search, loadLabelMessages,
    toggleSelectMessage, selectAllMessages, clearSelection, bulkMarkRead, bulkDelete,
  }
})
