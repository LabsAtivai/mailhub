<template>
  <div class="admin-layout">
    <header class="admin-header">
      <div class="header-left">
        <span class="logo"><span class="logo-ativa">ATIVA</span><span class="logo-ai">.ai</span></span>
        <span class="admin-title">Painel Admin</span>
      </div>
      <div class="header-right">
        <Button icon="pi pi-inbox" text size="small" label="MailHub" @click="router.push('/')" />
        <Button icon="pi pi-sign-out" text size="small" label="Sair" @click="logout" />
      </div>
    </header>

    <main class="admin-main">
      <!-- stats cards -->
      <div class="stats-grid" v-if="stats">
        <div class="stat-card">
          <div class="stat-value">{{ stats.users }}</div>
          <div class="stat-label">Usuarios</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats.accounts }}</div>
          <div class="stat-label">Contas IMAP</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ formatNumber(stats.messages) }}</div>
          <div class="stat-label">Mensagens</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats.syncingAccounts }}</div>
          <div class="stat-label">Sincronizando</div>
        </div>
        <div class="stat-card error" v-if="stats.errorAccounts > 0">
          <div class="stat-value">{{ stats.errorAccounts }}</div>
          <div class="stat-label">Com erro</div>
        </div>
      </div>

      <!-- tabs -->
      <div class="tab-bar">
        <button :class="{ active: tab === 'users' }" @click="tab = 'users'">Usuarios</button>
        <button :class="{ active: tab === 'accounts' }" @click="tab = 'accounts'">Contas IMAP</button>
      </div>

      <!-- USERS TAB -->
      <div v-if="tab === 'users'" class="tab-content">
        <div class="toolbar">
          <InputText v-model="userSearch" placeholder="Buscar usuario..." class="search-input" />
        </div>

        <table class="data-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Email</th>
              <th>Role</th>
              <th>Contas</th>
              <th>Criado em</th>
              <th>Acoes</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in filteredUsers" :key="u.id">
              <td>{{ u.name }}</td>
              <td>{{ u.email }}</td>
              <td>
                <span class="role-badge" :class="u.role">{{ u.role }}</span>
              </td>
              <td>{{ u.accountCount }}</td>
              <td>{{ formatDate(u.createdAt) }}</td>
              <td class="actions">
                <Button icon="pi pi-eye" text rounded size="small" v-tooltip="'Ver contas'"
                  @click="viewUser(u)" />
                <Button v-if="u.role === 'user'" icon="pi pi-shield" text rounded size="small"
                  v-tooltip="'Tornar admin'" @click="setRole(u.id, 'admin')" />
                <Button v-else icon="pi pi-user" text rounded size="small"
                  v-tooltip="'Remover admin'" @click="setRole(u.id, 'user')" />
                <Button icon="pi pi-trash" text rounded size="small" severity="danger"
                  v-tooltip="'Excluir'" @click="confirmDeleteUser(u)" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ACCOUNTS TAB -->
      <div v-if="tab === 'accounts'" class="tab-content">
        <div class="toolbar">
          <InputText v-model="accountSearch" placeholder="Buscar conta..." class="search-input" />
          <Button label="Nova conta" icon="pi pi-plus" size="small" @click="showAddAccount = true" />
        </div>

        <table class="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Dono</th>
              <th>Host IMAP</th>
              <th>Status</th>
              <th>Ultimo sync</th>
              <th>Acoes</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in filteredAccounts" :key="a.id">
              <td>{{ a.emailAddress }}</td>
              <td>{{ a.user?.name || '-' }}</td>
              <td class="host-cell">{{ a.incomingHost }}:{{ a.incomingPort }}</td>
              <td>
                <span class="status-badge" :class="a.syncState.toLowerCase()">{{ a.syncState }}</span>
              </td>
              <td>{{ a.lastSyncAt ? formatDate(a.lastSyncAt) : 'Nunca' }}</td>
              <td class="actions">
                <Button icon="pi pi-sync" text rounded size="small" v-tooltip="'Forcar sync'"
                  @click="forceSync(a.id)" />
                <Button :icon="a.syncEnabled ? 'pi pi-pause' : 'pi pi-play'" text rounded size="small"
                  :v-tooltip="a.syncEnabled ? 'Desativar' : 'Ativar'"
                  @click="toggleSync(a.id, !a.syncEnabled)" />
                <Button icon="pi pi-trash" text rounded size="small" severity="danger"
                  v-tooltip="'Excluir'" @click="confirmDeleteAccount(a)" />
              </td>
            </tr>
          </tbody>
        </table>

        <div v-for="a in filteredAccounts.filter(x => x.lastError)" :key="'err-'+a.id" class="error-row">
          <b>{{ a.emailAddress }}:</b> {{ a.lastError }}
        </div>
      </div>

      <!-- user detail dialog -->
      <Dialog v-model:visible="showUserDetail" :header="selectedUser?.name || 'Usuario'" modal
        :style="{ width: '600px' }">
        <div v-if="userDetail">
          <p><b>Email:</b> {{ userDetail.email }}</p>
          <p><b>Role:</b> {{ userDetail.role }}</p>
          <p><b>Criado:</b> {{ formatDate(userDetail.createdAt) }}</p>
          <h4 style="margin:.8rem 0 .4rem">Contas IMAP ({{ userDetail.accounts?.length || 0 }})</h4>
          <table class="data-table compact" v-if="userDetail.accounts?.length">
            <thead><tr><th>Email</th><th>Host</th><th>Status</th><th>Pastas</th></tr></thead>
            <tbody>
              <tr v-for="acc in userDetail.accounts" :key="acc.id">
                <td>{{ acc.emailAddress }}</td>
                <td>{{ acc.incomingHost }}</td>
                <td><span class="status-badge" :class="acc.syncState.toLowerCase()">{{ acc.syncState }}</span></td>
                <td>{{ acc._count?.folders || 0 }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else style="color:#888">Nenhuma conta cadastrada.</p>
        </div>
      </Dialog>

      <!-- add account dialog -->
      <Dialog v-model:visible="showAddAccount" header="Nova conta IMAP" modal :style="{ width: '500px' }">
        <div class="form-grid">
          <div class="field">
            <label>Usuario (dono)</label>
            <Select v-model="newAcc.userId" :options="users" optionLabel="name" optionValue="id"
              placeholder="Selecione" style="width:100%" />
          </div>
          <div class="field">
            <label>Nome exibicao</label>
            <InputText v-model="newAcc.displayName" style="width:100%" />
          </div>
          <div class="field">
            <label>Email</label>
            <InputText v-model="newAcc.emailAddress" style="width:100%" />
          </div>
          <div class="field">
            <label>Host IMAP</label>
            <InputText v-model="newAcc.incomingHost" style="width:100%" />
          </div>
          <div class="field half">
            <label>Porta IMAP</label>
            <InputText :model-value="String(newAcc.incomingPort)"
              @update:model-value="newAcc.incomingPort = Number($event) || 993" style="width:100%" />
          </div>
          <div class="field half">
            <label>TLS</label>
            <Select v-model="newAcc.tlsMode" :options="['TLS','STARTTLS']" style="width:100%" />
          </div>
          <div class="field">
            <label>Host SMTP</label>
            <InputText v-model="newAcc.outgoingHost" style="width:100%" />
          </div>
          <div class="field half">
            <label>Porta SMTP</label>
            <InputText :model-value="String(newAcc.outgoingPort)"
              @update:model-value="newAcc.outgoingPort = Number($event) || 465" style="width:100%" />
          </div>
          <div class="field">
            <label>Usuario IMAP</label>
            <InputText v-model="newAcc.username" style="width:100%" />
          </div>
          <div class="field">
            <label>Senha</label>
            <InputText v-model="newAcc.password" type="password" style="width:100%" />
          </div>
        </div>
        <div v-if="addError" class="form-error">{{ addError }}</div>
        <template #footer>
          <Button label="Cancelar" text @click="showAddAccount = false" />
          <Button label="Criar" :loading="addingAccount" @click="createAccount" />
        </template>
      </Dialog>

      <!-- confirm delete -->
      <Dialog v-model:visible="showConfirmDelete" header="Confirmar exclusao" modal :style="{ width: '400px' }">
        <p>{{ confirmMsg }}</p>
        <template #footer>
          <Button label="Cancelar" text @click="showConfirmDelete = false" />
          <Button label="Excluir" severity="danger" @click="executeDelete" />
        </template>
      </Dialog>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import { api } from '../services/api'
import { useAuthStore } from '../stores/auth'
import { useRouter } from 'vue-router'
import { useToast } from 'primevue/usetoast'

const auth = useAuthStore()
const router = useRouter()
const toast = useToast()

interface AdminUser {
  id: string; name: string; email: string; role: string
  createdAt: string; accountCount: number
}
interface AdminAccount {
  id: string; displayName: string; emailAddress: string
  incomingHost: string; incomingPort: number
  outgoingHost: string; outgoingPort: number
  username: string; tlsMode: string
  syncEnabled: boolean; syncState: string
  lastSyncAt: string | null; lastError: string | null
  createdAt: string
  user?: { id: string; name: string; email: string }
  _count?: { folders: number }
}
interface Stats {
  users: number; accounts: number; messages: number
  folders: number; syncingAccounts: number; errorAccounts: number
}

const tab = ref<'users' | 'accounts'>('users')
const stats = ref<Stats | null>(null)
const users = ref<AdminUser[]>([])
const accounts = ref<AdminAccount[]>([])
const userSearch = ref('')
const accountSearch = ref('')

const showUserDetail = ref(false)
const selectedUser = ref<AdminUser | null>(null)
const userDetail = ref<{ email: string; role: string; createdAt: string; accounts: AdminAccount[] } | null>(null)

const showAddAccount = ref(false)
const addingAccount = ref(false)
const addError = ref('')
const newAcc = reactive({
  userId: '', displayName: '', emailAddress: '',
  incomingHost: 'sh-pro132.hostgator.com.br', incomingPort: 993,
  outgoingHost: 'sh-pro132.hostgator.com.br', outgoingPort: 465,
  username: '', password: '', tlsMode: 'TLS',
})

const showConfirmDelete = ref(false)
const confirmMsg = ref('')
let pendingDelete: (() => Promise<void>) | null = null

const filteredUsers = computed(() => {
  if (!userSearch.value) return users.value
  const q = userSearch.value.toLowerCase()
  return users.value.filter(u =>
    u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  )
})

const filteredAccounts = computed(() => {
  if (!accountSearch.value) return accounts.value
  const q = accountSearch.value.toLowerCase()
  return accounts.value.filter(a =>
    a.emailAddress.toLowerCase().includes(q) ||
    a.user?.name?.toLowerCase().includes(q) ||
    a.incomingHost.toLowerCase().includes(q)
  )
})

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
}

function formatNumber(n: number) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

async function loadData() {
  const [s, u, a] = await Promise.all([
    api.get('/admin/stats'),
    api.get('/admin/users'),
    api.get('/admin/accounts'),
  ])
  stats.value = s.data
  users.value = u.data
  accounts.value = a.data
}

async function viewUser(u: AdminUser) {
  selectedUser.value = u
  const { data } = await api.get(`/admin/users/${u.id}`)
  userDetail.value = data
  showUserDetail.value = true
}

async function setRole(userId: string, role: string) {
  await api.patch(`/admin/users/${userId}`, { role })
  toast.add({ severity: 'success', summary: `Role alterado para ${role}`, life: 2000 })
  await loadData()
}

function confirmDeleteUser(u: AdminUser) {
  confirmMsg.value = `Excluir usuario "${u.name}" (${u.email}) e todas as suas contas/dados?`
  pendingDelete = async () => {
    await api.delete(`/admin/users/${u.id}`)
    toast.add({ severity: 'success', summary: 'Usuario excluido', life: 2000 })
    await loadData()
  }
  showConfirmDelete.value = true
}

function confirmDeleteAccount(a: AdminAccount) {
  confirmMsg.value = `Excluir conta "${a.emailAddress}" e todos os emails sincronizados?`
  pendingDelete = async () => {
    await api.delete(`/admin/accounts/${a.id}`)
    toast.add({ severity: 'success', summary: 'Conta excluida', life: 2000 })
    await loadData()
  }
  showConfirmDelete.value = true
}

async function executeDelete() {
  if (pendingDelete) await pendingDelete()
  showConfirmDelete.value = false
  pendingDelete = null
}

async function forceSync(accountId: string) {
  await api.post(`/admin/accounts/${accountId}/sync`)
  toast.add({ severity: 'info', summary: 'Sync iniciado', life: 2000 })
  setTimeout(loadData, 3000)
}

async function toggleSync(accountId: string, enabled: boolean) {
  await api.patch(`/admin/accounts/${accountId}`, { syncEnabled: enabled })
  toast.add({ severity: 'success', summary: enabled ? 'Sync ativado' : 'Sync desativado', life: 2000 })
  await loadData()
}

async function createAccount() {
  addError.value = ''
  if (!newAcc.userId) { addError.value = 'Selecione um usuario'; return }
  if (!newAcc.emailAddress) { addError.value = 'Email obrigatorio'; return }
  if (!newAcc.password) { addError.value = 'Senha obrigatoria'; return }
  if (!newAcc.username) newAcc.username = newAcc.emailAddress
  addingAccount.value = true
  try {
    await api.post('/admin/accounts', newAcc)
    toast.add({ severity: 'success', summary: 'Conta criada', life: 2000 })
    showAddAccount.value = false
    Object.assign(newAcc, {
      userId: '', displayName: '', emailAddress: '',
      username: '', password: '',
    })
    await loadData()
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } } }
    addError.value = err?.response?.data?.error ? String(err.response.data.error) : 'Erro ao criar conta'
  } finally {
    addingAccount.value = false
  }
}

function logout() {
  auth.logout()
  router.push('/login')
}

onMounted(loadData)
</script>

<style scoped>
.admin-layout { display: flex; flex-direction: column; height: 100vh; background: #f5f6fa; }

.admin-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: .5rem 1.2rem; background: #fff;
  border-bottom: 1px solid #e0e0e0; flex-shrink: 0;
}
.header-left { display: flex; align-items: center; gap: .8rem; }
.logo { font-weight: 700; font-size: 1.1rem; }
.logo-ativa { color: #111; }
.logo-ai { color: #F47A20; }
.admin-title { font-size: .85rem; color: #666; font-weight: 500; }
.header-right { display: flex; gap: .3rem; }

.admin-main { flex: 1; overflow-y: auto; padding: 1.2rem; max-width: 1200px; margin: 0 auto; width: 100%; }

.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .8rem; margin-bottom: 1.2rem; }
.stat-card {
  background: #fff; border-radius: 10px; padding: 1rem;
  box-shadow: 0 1px 3px rgba(0,0,0,.08); text-align: center;
}
.stat-card.error { border-left: 3px solid #f44336; }
.stat-value { font-size: 1.6rem; font-weight: 700; color: #1a1a1a; }
.stat-label { font-size: .75rem; color: #888; margin-top: .2rem; text-transform: uppercase; letter-spacing: .04em; }

.tab-bar { display: flex; gap: 0; margin-bottom: 1rem; border-bottom: 2px solid #e0e0e0; }
.tab-bar button {
  background: none; border: none; padding: .6rem 1.2rem;
  font-size: .85rem; font-weight: 500; cursor: pointer; color: #666;
  border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all .15s;
}
.tab-bar button.active { color: #F47A20; border-bottom-color: #F47A20; }
.tab-bar button:hover { color: #333; }

.tab-content { background: #fff; border-radius: 10px; padding: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }

.toolbar { display: flex; gap: .6rem; margin-bottom: .8rem; align-items: center; }
.search-input { flex: 1; max-width: 320px; }

.data-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
.data-table th {
  text-align: left; padding: .5rem .6rem; font-weight: 600; color: #666;
  border-bottom: 2px solid #eee; font-size: .75rem; text-transform: uppercase; letter-spacing: .03em;
}
.data-table td { padding: .5rem .6rem; border-bottom: 1px solid #f0f0f0; }
.data-table tr:hover td { background: #fafafa; }
.data-table.compact th, .data-table.compact td { padding: .35rem .5rem; font-size: .78rem; }
.host-cell { font-family: monospace; font-size: .76rem; }
.actions { white-space: nowrap; }

.role-badge {
  display: inline-block; padding: .1rem .5rem; border-radius: 12px;
  font-size: .7rem; font-weight: 600; text-transform: uppercase;
}
.role-badge.admin { background: #F47A20; color: #fff; }
.role-badge.user { background: #e8e8e8; color: #666; }

.status-badge {
  display: inline-block; padding: .1rem .5rem; border-radius: 12px;
  font-size: .7rem; font-weight: 600; text-transform: uppercase;
}
.status-badge.idle { background: #e8f5e9; color: #2e7d32; }
.status-badge.syncing { background: #e3f2fd; color: #1565c0; }
.status-badge.error { background: #ffebee; color: #c62828; }
.status-badge.pending { background: #fff3e0; color: #e65100; }

.error-row {
  margin-top: .5rem; padding: .5rem .8rem;
  background: #fff3e0; border-radius: 6px; font-size: .78rem; color: #e65100;
}

.form-grid { display: flex; flex-wrap: wrap; gap: .6rem; }
.field { width: 100%; }
.field.half { width: calc(50% - .3rem); }
.field label { display: block; font-size: .75rem; font-weight: 600; color: #666; margin-bottom: .2rem; }
.form-error { color: #c62828; font-size: .8rem; margin-top: .5rem; }
</style>
