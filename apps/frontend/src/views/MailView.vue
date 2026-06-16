<template>
  <div class="mail-layout">

    <!-- ── sidebar ──────────────────────────────────────────────────────── -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <span class="logo">MailHub</span>
        <Button icon="pi pi-sign-out" text rounded size="small"
          v-tooltip="'Sair'" @click="logout" />
      </div>

      <Button label="Compor" icon="pi pi-pencil" class="compose-btn" @click="openCompose(null)" />

      <div class="search-wrap">
        <span class="p-input-icon-left" style="width:100%">
          <i class="pi pi-search" style="position:absolute;left:.6rem;top:50%;transform:translateY(-50%);color:#888;font-size:.8rem" />
          <InputText v-model="searchInput" placeholder="Buscar..." style="width:100%;padding-left:2rem"
            @keydown.enter="doSearch" @input="onSearchInput" />
        </span>
      </div>

      <!-- accounts + folders -->
      <div v-for="acc in mail.accounts" :key="acc.id" class="account-section">
        <div class="account-header" @click="toggleAccount(acc.id)">
          <i class="pi pi-chevron-right expand-icon" :class="{ expanded: expandedAccounts.has(acc.id) }"></i>
          <span class="account-email" :title="acc.emailAddress">{{ acc.emailAddress }}</span>
          <span v-if="acc.syncState === 'SYNCING'" class="sync-badge">↻</span>
          <span v-else-if="acc.syncState === 'ERROR'" class="err-badge" :title="acc.lastError ?? ''">!</span>
        </div>

        <div v-if="acc.syncState === 'SYNCING' && mail.syncProgress[acc.id]" class="sync-progress">
          <div class="sync-bar" :style="{ width: (mail.syncProgress[acc.id]?.progress ?? 0) + '%' }"></div>
          <span class="sync-label">{{ mail.syncProgress[acc.id]?.currentFolder ?? 'Sincronizando...' }}</span>
        </div>

        <ul v-show="expandedAccounts.has(acc.id)" class="folder-list">
          <li v-for="folder in mail.foldersByAccount[acc.id] ?? []" :key="folder.id"
            :class="{ active: folder.id === mail.selectedFolderId }"
            @click="mail.selectFolder(acc.id, folder.id); searchInput = ''">
            <i :class="folderIcon(folder.specialUse)" style="font-size:.8rem;width:14px"></i>
            <span class="folder-name">{{ folder.name }}</span>
            <span v-if="folder.unreadCount > 0" class="unread-badge">{{ folder.unreadCount }}</span>
          </li>
        </ul>
      </div>

      <Divider style="margin:.5rem 0" />

      <div class="sidebar-section-title">
        <span>Etiquetas</span>
        <button class="icon-btn" v-tooltip="'Gerenciar etiquetas'" @click="showLabelManager = true">
          <i class="pi pi-cog"></i>
        </button>
      </div>

      <ul class="folder-list" v-if="labelStore.labels.length > 0">
        <li v-for="label in labelStore.labels" :key="label.id"
          :class="{ active: activeLabelId === label.id }"
          @click="selectLabel(label.id)">
          <span class="label-dot-sm" :style="{ background: label.color }"></span>
          <span class="folder-name">{{ label.name }}</span>
          <span v-if="label.messageCount > 0" class="unread-badge" :style="{ background: label.color }">
            {{ label.messageCount }}
          </span>
        </li>
      </ul>
      <button v-else class="add-label-btn" @click="showLabelManager = true">
        + Nova etiqueta
      </button>

      <Divider style="margin:.5rem 0" />
      <button class="add-label-btn" @click="showAddAccount = true">+ Conta IMAP</button>

      <div class="socket-status" :class="{ connected: mail.connected }">
        <i class="pi" :class="mail.connected ? 'pi-circle-fill' : 'pi-circle'" style="font-size:.6rem"></i>
        {{ mail.connected ? 'Tempo real' : 'Reconectando...' }}
      </div>
    </aside>

    <!-- ── message list ──────────────────────────────────────────────────── -->
    <section class="msg-list">
      <div class="msg-list-header">
        <span class="folder-title">{{ listTitle }}</span>
        <span class="msg-count">{{ displayMessages.length }}</span>
      </div>

      <div class="msg-items" @scroll="onListScroll">
        <template v-if="mail.loadingMessages && displayMessages.length === 0">
          <div v-for="n in 8" :key="n" class="msg-skeleton">
            <div class="sk-line w60"></div>
            <div class="sk-line w90"></div>
            <div class="sk-line w80"></div>
          </div>
        </template>

        <div v-else-if="displayMessages.length === 0 && !mail.loadingMessages" class="empty-list">
          <i class="pi pi-inbox"></i>
          <span>{{ searchInput ? 'Nenhum resultado' : 'Pasta vazia' }}</span>
        </div>

        <div v-for="msg in displayMessages" :key="msg.id"
          class="msg-item"
          :class="{ unread: !msg.isRead, selected: msg.id === mail.selectedMessage?.id }"
          @click="mail.selectMessage(msg.id)">
          <div class="msg-row1">
            <span class="msg-sender">{{ msg.fromName || msg.fromEmail || '(sem remetente)' }}</span>
            <span class="msg-date">{{ formatDate(msg.date) }}</span>
          </div>
          <div class="msg-subject">{{ msg.subject || '(sem assunto)' }}</div>
          <div class="msg-row3">
            <span class="msg-preview">{{ msg.preview || '' }}</span>
            <i v-if="msg.hasAttachments" class="pi pi-paperclip att-icon"></i>
            <i class="pi flag-btn"
              :class="msg.isFlagged ? 'pi-star-fill flagged' : 'pi-star'"
              @click.stop="mail.toggleFlag(msg.id, !msg.isFlagged)"></i>
          </div>
        </div>

        <div v-if="mail.nextCursor && !searchInput && !activeLabelId" class="load-more">
          <Button label="Carregar mais" text size="small"
            :loading="mail.loadingMessages" @click="mail.loadMessages(true)" />
        </div>
      </div>
    </section>

    <!-- ── message viewer ────────────────────────────────────────────────── -->
    <section class="msg-viewer" v-if="mail.selectedMessage">
      <div class="viewer-header">
        <Button icon="pi pi-arrow-left" text rounded size="small" @click="mail.selectedMessage = null" />
        <div class="viewer-actions">
          <LabelPicker
            :message-id="mail.selectedMessage.id"
            :initial-labels="mail.selectedMessage.labels ?? []"
            @manage="showLabelManager = true" />
          <Button icon="pi pi-reply" text size="small" label="Responder" @click="openCompose(mail.selectedMessage)" />
          <Button icon="pi pi-forward" text size="small" label="Enc." @click="openForward(mail.selectedMessage)" />
          <Button :icon="mail.selectedMessage.isFlagged ? 'pi-star-fill' : 'pi-star'"
            text rounded size="small"
            :class="{ 'star-active': mail.selectedMessage.isFlagged }"
            @click="mail.toggleFlag(mail.selectedMessage!.id, !mail.selectedMessage!.isFlagged)"
            v-tooltip="mail.selectedMessage.isFlagged ? 'Remover favorito' : 'Favoritar'">
            <i :class="['pi', mail.selectedMessage.isFlagged ? 'pi-star-fill' : 'pi-star']"></i>
          </Button>
          <Button icon="pi pi-trash" text rounded size="small" severity="danger"
            @click="mail.deleteMessage(mail.selectedMessage!.id)" v-tooltip="'Lixeira'" />
        </div>
      </div>

      <div class="viewer-subject">{{ mail.selectedMessage.subject || '(sem assunto)' }}</div>

      <div class="viewer-meta">
        <span class="viewer-from">
          <b>{{ mail.selectedMessage.fromName || mail.selectedMessage.fromEmail }}</b>
          <span v-if="mail.selectedMessage.fromName" class="from-addr">&lt;{{ mail.selectedMessage.fromEmail }}&gt;</span>
        </span>
        <span class="viewer-date">{{ formatDateFull(mail.selectedMessage.date) }}</span>
      </div>
      <div class="viewer-to">Para: {{ formatAddresses(mail.selectedMessage.toJson) }}</div>

      <!-- label chips -->
      <div v-if="(mail.selectedMessage.labels ?? []).length > 0" class="viewer-labels">
        <span v-for="l in mail.selectedMessage.labels" :key="l.id"
          class="label-chip"
          :style="{ background: l.color + '22', borderColor: l.color, color: l.color }">
          {{ l.name }}
        </span>
      </div>

      <Divider style="margin:.4rem 0" />

      <!-- attachments -->
      <div v-if="visibleAttachments.length > 0" class="attachments">
        <div v-for="att in visibleAttachments" :key="att.id" class="att-chip">
          <i class="pi pi-file" style="font-size:.75rem"></i>
          <span>{{ att.filename }}</span>
          <span class="att-size">{{ formatSize(att.size) }}</span>
          <Button icon="pi pi-download" text rounded size="small" @click="downloadAttachment(att)" />
        </div>
      </div>

      <!-- body -->
      <div v-if="mail.loadingMessage || mail.selectedMessage.bodyFetching" class="body-loading">
        <i class="pi pi-spin pi-spinner"></i> Carregando...
      </div>
      <div v-else class="viewer-body">
        <iframe v-if="mail.selectedMessage.htmlBody"
          :srcdoc="sanitizedBody"
          sandbox="allow-same-origin"
          class="html-frame"
          ref="frameRef"
          @load="resizeFrame" />
        <pre v-else-if="mail.selectedMessage.textBody" class="text-body">{{ mail.selectedMessage.textBody }}</pre>
        <div v-else class="no-body">Corpo não disponível.</div>
      </div>
    </section>

    <section class="viewer-empty" v-else>
      <i class="pi pi-envelope-open"></i>
      <p>Selecione uma mensagem</p>
    </section>

    <!-- dialogs -->
    <AddAccountDialog v-model:visible="showAddAccount" @added="mail.fetchAccounts()" />
    <ComposeDialog v-model:visible="showCompose" :reply-to="replyTo" :forward-msg="forwardMsg" @sent="showCompose = false" />
    <LabelManagerDialog v-model:visible="showLabelManager" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import Button from 'primevue/button'
import Divider from 'primevue/divider'
import InputText from 'primevue/inputtext'
import DOMPurify from 'dompurify'
import { useAuthStore } from '../stores/auth'
import { useMailStore, type MessageDetail, type Attachment } from '../stores/mail'
import { useLabelStore } from '../stores/labels'
import AddAccountDialog from '../components/AddAccountDialog.vue'
import ComposeDialog from '../components/ComposeDialog.vue'
import LabelManagerDialog from '../components/LabelManagerDialog.vue'
import LabelPicker from '../components/LabelPicker.vue'
import { api } from '../services/api'
import { useRouter } from 'vue-router'

const auth = useAuthStore()
const mail = useMailStore()
const labelStore = useLabelStore()
const router = useRouter()

const showAddAccount = ref(false)
const showCompose = ref(false)
const showLabelManager = ref(false)
const replyTo = ref<MessageDetail | null>(null)
const forwardMsg = ref<MessageDetail | null>(null)
const frameRef = ref<HTMLIFrameElement | null>(null)
const searchInput = ref('')
const activeLabelId = ref<string | null>(null)
const expandedAccounts = ref(new Set<string>())

onMounted(async () => {
  await mail.fetchAccounts()
  await labelStore.fetchLabels()
  mail.accounts.forEach(acc => expandedAccounts.value.add(acc.id))
})

// Memoize sanitized HTML — only recompute when message changes
const sanitizedBody = computed(() => {
  const html = mail.selectedMessage?.htmlBody
  if (!html) return ''
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'form', 'input', 'object', 'embed'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus'],
  })
})

const displayMessages = computed(() =>
  searchInput.value ? mail.searchResults : mail.messages
)

const listTitle = computed(() => {
  if (searchInput.value) return `"${searchInput.value}"`
  if (activeLabelId.value) {
    return labelStore.labels.find(l => l.id === activeLabelId.value)?.name ?? 'Etiqueta'
  }
  for (const folders of Object.values(mail.foldersByAccount)) {
    const f = folders.find(x => x.id === mail.selectedFolderId)
    if (f) return f.name
  }
  return 'Caixa de entrada'
})

const visibleAttachments = computed(() =>
  (mail.selectedMessage?.attachments ?? []).filter(a => !a.isInline)
)

function toggleAccount(id: string) {
  if (expandedAccounts.value.has(id)) expandedAccounts.value.delete(id)
  else expandedAccounts.value.add(id)
  // trigger reactivity
  expandedAccounts.value = new Set(expandedAccounts.value)
}

function folderIcon(specialUse: string | null): string {
  const map: Record<string, string> = {
    '\\Inbox': 'pi pi-inbox', '\\Sent': 'pi pi-send',
    '\\Drafts': 'pi pi-file-edit', '\\Trash': 'pi pi-trash',
    '\\Junk': 'pi pi-ban', '\\Archive': 'pi pi-box', '\\Flagged': 'pi pi-star',
  }
  return map[specialUse || ''] || 'pi pi-folder'
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

function formatDateFull(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function formatAddresses(json: string): string {
  try { return JSON.parse(json).map((x: any) => x.address || x.name || x).join(', ') }
  catch { return json }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

function resizeFrame() {
  nextTick(() => {
    if (!frameRef.value?.contentDocument?.body) return
    frameRef.value.style.height = frameRef.value.contentDocument.documentElement.scrollHeight + 32 + 'px'
  })
}

function onListScroll(e: Event) {
  const el = e.target as HTMLElement
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 100
    && mail.nextCursor && !mail.loadingMessages && !searchInput.value && !activeLabelId.value) {
    mail.loadMessages(true)
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
function onSearchInput() {
  clearTimeout(searchTimer)
  activeLabelId.value = null
  if (!searchInput.value) { mail.search(''); return }
  searchTimer = setTimeout(doSearch, 400)
}
function doSearch() { if (searchInput.value) mail.search(searchInput.value) }

async function selectLabel(labelId: string) {
  activeLabelId.value = labelId
  searchInput.value = ''
  mail.selectedMessage = null
  const result = await labelStore.fetchLabelMessages(labelId)
  await mail.loadLabelMessages(labelId, result.items, result.nextCursor)
}

function openCompose(msg: MessageDetail | null) {
  replyTo.value = msg; forwardMsg.value = null; showCompose.value = true
}
function openForward(msg: MessageDetail) {
  forwardMsg.value = msg; replyTo.value = null; showCompose.value = true
}

function logout() {
  auth.logout()
  router.push('/login')
}

async function downloadAttachment(att: Attachment) {
  try {
    const response = await api.get(`/attachments/${att.id}/download`, { responseType: 'blob' })
    if (response.data instanceof Blob && response.data.size > 50) {
      const url = URL.createObjectURL(response.data)
      const a = document.createElement('a')
      a.href = url; a.download = att.filename; a.click()
      URL.revokeObjectURL(url)
    }
  } catch { /* silently fail */ }
}
</script>

<style scoped>
.mail-layout {
  display: grid;
  grid-template-columns: 228px minmax(260px, 320px) 1fr;
  height: 100vh; overflow: hidden; background: var(--p-surface-0);
}

/* ── sidebar ─────────────────────────────────────────────────────────────── */
.sidebar {
  display: flex; flex-direction: column; gap: .3rem;
  border-right: 1px solid var(--p-surface-200);
  padding: .6rem .5rem; overflow-y: auto; min-width: 0;
  background: var(--p-surface-50);
}
.sidebar-header { display: flex; align-items: center; justify-content: space-between; padding: 0 .25rem; }
.logo { font-weight: 700; font-size: 1.05rem; }
.compose-btn { width: 100%; justify-content: center; font-size: .85rem; margin-top: .1rem; }
.search-wrap { position: relative; margin: .1rem 0; }

.account-section { margin-top: .2rem; }
.account-header {
  display: flex; align-items: center; gap: .35rem; padding: .3rem .4rem;
  border-radius: 6px; cursor: pointer; font-size: .72rem; color: var(--p-text-muted-color);
  user-select: none;
}
.account-header:hover { background: var(--p-surface-100); }
.expand-icon { font-size: .6rem; transition: transform .15s; }
.expand-icon.expanded { transform: rotate(90deg); }
.account-email { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sync-badge { font-size: .7rem; color: var(--p-blue-500); animation: spin 1s linear infinite; }
.err-badge { font-size: .7rem; color: var(--p-red-500); font-weight: 700; cursor: help; }
@keyframes spin { to { transform: rotate(360deg); } }

.sync-progress { padding: 0 .4rem 2px; }
.sync-bar { height: 2px; background: var(--p-primary-color); border-radius: 1px; transition: width .4s; }
.sync-label { font-size: .62rem; color: var(--p-text-muted-color); display: block; margin-top: 1px; }

.folder-list { list-style: none; margin: 0; padding: 0; }
.folder-list li {
  display: flex; align-items: center; gap: .4rem;
  padding: .32rem .6rem; border-radius: 7px; cursor: pointer;
  font-size: .82rem; transition: background .1s; user-select: none;
}
.folder-list li:hover { background: var(--p-surface-100); }
.folder-list li.active { background: var(--p-primary-100); color: var(--p-primary-600); font-weight: 600; }
.folder-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.unread-badge {
  font-size: .65rem; font-weight: 700; min-width: 18px; height: 18px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--p-primary-500); color: #fff; border-radius: 9px; padding: 0 5px;
}

.sidebar-section-title {
  display: flex; align-items: center; justify-content: space-between;
  padding: .15rem .4rem; font-size: .68rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: .06em; color: var(--p-text-muted-color);
}
.label-dot-sm { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.icon-btn {
  background: none; border: none; cursor: pointer; padding: 2px 4px;
  border-radius: 4px; color: var(--p-text-muted-color); font-size: .8rem;
}
.icon-btn:hover { background: var(--p-surface-200); }
.add-label-btn {
  background: none; border: none; cursor: pointer; text-align: left;
  padding: .3rem .6rem; font-size: .8rem; color: var(--p-primary-color);
  border-radius: 6px; width: 100%;
}
.add-label-btn:hover { background: var(--p-surface-100); }
.socket-status {
  margin-top: auto; display: flex; align-items: center; gap: .35rem;
  font-size: .68rem; color: var(--p-text-muted-color); padding: .4rem .5rem;
}
.socket-status.connected { color: #16a34a; }

/* ── message list ─────────────────────────────────────────────────────────── */
.msg-list { display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid var(--p-surface-200); }
.msg-list-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: .55rem .9rem; border-bottom: 1px solid var(--p-surface-200);
  flex-shrink: 0; min-height: 42px;
}
.folder-title { font-weight: 600; font-size: .88rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-count { font-size: .72rem; color: var(--p-text-muted-color); margin-left: .5rem; white-space: nowrap; }

.msg-items { flex: 1; overflow-y: auto; }
.empty-list {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: .5rem; height: 160px; color: var(--p-text-muted-color); font-size: .85rem;
}
.empty-list i { font-size: 1.8rem; opacity: .25; }

/* skeleton */
.msg-skeleton { padding: .65rem .9rem; border-bottom: 1px solid var(--p-surface-100); }
.sk-line { height: 10px; border-radius: 5px; background: var(--p-surface-200); margin-bottom: 6px; }
.sk-line.w60 { width: 60%; }
.sk-line.w90 { width: 90%; }
.sk-line.w80 { width: 80%; }

.msg-item {
  padding: .55rem .9rem; border-bottom: 1px solid var(--p-surface-100);
  cursor: pointer; transition: background .08s;
}
.msg-item:hover { background: var(--p-surface-50); }
.msg-item.selected { background: var(--p-primary-50); }
.msg-item.unread .msg-sender, .msg-item.unread .msg-subject { font-weight: 700; }
.msg-row1 { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; }
.msg-sender { font-size: .84rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.msg-date { font-size: .7rem; color: var(--p-text-muted-color); white-space: nowrap; }
.msg-subject { font-size: .79rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 1px 0; }
.msg-row3 { display: flex; align-items: center; gap: .4rem; }
.msg-preview { font-size: .74rem; color: var(--p-text-muted-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.att-icon { font-size: .72rem; color: var(--p-text-muted-color); }
.flag-btn { font-size: .78rem; color: var(--p-text-muted-color); cursor: pointer; flex-shrink: 0; }
.flag-btn.flagged { color: #f59e0b; }
.load-more { padding: .6rem; text-align: center; }

/* ── viewer ──────────────────────────────────────────────────────────────── */
.msg-viewer { display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
.viewer-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: .5rem; color: var(--p-text-muted-color);
}
.viewer-empty i { font-size: 2.5rem; opacity: .2; }
.viewer-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: .35rem .75rem; border-bottom: 1px solid var(--p-surface-200); flex-shrink: 0;
}
.viewer-actions { display: flex; align-items: center; gap: .1rem; }
.star-active i { color: #f59e0b; }
.viewer-subject { font-size: 1.1rem; font-weight: 600; padding: .65rem 1rem .2rem; flex-shrink: 0; }
.viewer-meta { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: 0 1rem .15rem; flex-shrink: 0; }
.viewer-from { font-size: .84rem; }
.from-addr { color: var(--p-text-muted-color); font-size: .78rem; margin-left: .3rem; }
.viewer-date { font-size: .74rem; color: var(--p-text-muted-color); white-space: nowrap; }
.viewer-to { padding: 0 1rem .25rem; font-size: .78rem; color: var(--p-text-muted-color); flex-shrink: 0; }
.viewer-labels { display: flex; flex-wrap: wrap; gap: .3rem; padding: 0 1rem .4rem; flex-shrink: 0; }
.label-chip {
  display: inline-flex; align-items: center; gap: .25rem;
  padding: .1rem .5rem; border-radius: 20px; border: 1px solid;
  font-size: .73rem; font-weight: 500; white-space: nowrap;
}
.attachments {
  display: flex; flex-wrap: wrap; gap: .4rem;
  padding: .35rem 1rem; border-bottom: 1px solid var(--p-surface-100); flex-shrink: 0;
}
.att-chip {
  display: inline-flex; align-items: center; gap: .3rem;
  background: var(--p-surface-100); border-radius: 6px; padding: .2rem .5rem;
  font-size: .78rem; max-width: 260px;
}
.att-size { color: var(--p-text-muted-color); white-space: nowrap; }
.body-loading { display: flex; align-items: center; gap: .5rem; padding: 1.5rem 1rem; color: var(--p-text-muted-color); font-size: .85rem; }
.viewer-body { flex: 1; overflow-y: auto; padding: .5rem 1rem 1.5rem; }
.html-frame { width: 100%; border: none; min-height: 200px; display: block; }
.text-body { white-space: pre-wrap; font-size: .875rem; line-height: 1.65; font-family: inherit; margin: 0; }
.no-body { color: var(--p-text-muted-color); font-size: .875rem; padding: 1rem 0; }

/* ── responsive ────────────────────────────────────────────────────────────── */
@media (max-width: 860px) {
  .mail-layout { grid-template-columns: 200px 1fr; }
  .msg-viewer, .viewer-empty { display: none; }
}
@media (max-width: 580px) {
  .mail-layout { grid-template-columns: 1fr; }
  .sidebar { display: none; }
}
</style>
