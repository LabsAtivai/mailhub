<template>
  <div class="neg-layout">
    <header class="neg-header">
      <div class="header-left">
        <span class="logo"><span class="logo-ativa">ATIVA</span><span class="logo-ai">.ai</span></span>
        <span class="neg-title">Negativação</span>
      </div>
      <div class="header-right">
        <Button icon="pi pi-inbox" text size="small" label="MailHub" @click="router.push('/')" />
      </div>
    </header>

    <main class="neg-main">
      <section class="neg-card">
        <h2>Negativar e-mail ou domínio</h2>
        <p class="hint">
          O valor entra na Lista de e-mails a não enviar só da conta Snov.io dona da caixa escolhida
          (achada pelo domínio da caixa). Use para pedidos de remoção.
        </p>
        <form class="neg-form" @submit.prevent="submit">
          <Select v-model="accountId" :options="accounts" optionValue="id" optionLabel="emailAddress"
            placeholder="Caixa dona" class="neg-select" :disabled="submitting" />
          <InputText v-model="value" placeholder="email@dominio.com ou dominio.com" class="neg-input" :disabled="submitting" />
          <Button type="submit" label="Negativar em todas as contas" icon="pi pi-ban" severity="danger"
            :loading="submitting" :disabled="!value.trim() || !accountId" />
        </form>
      </section>

      <section class="neg-card">
        <h2>Histórico</h2>
        <div v-if="!runs.length" class="empty">Nenhuma negativação ainda.</div>
        <table v-else class="data-table">
          <thead>
            <tr><th>Quando</th><th>Valor</th><th>Tipo</th><th>Status</th></tr>
          </thead>
          <tbody>
            <template v-for="r in runs" :key="r.id">
              <tr class="clickable" @click="toggle(r.id)">
                <td>{{ formatDate(r.started_at) }}</td>
                <td>{{ r.value }}</td>
                <td>{{ r.kind === 'domain' ? 'Domínio' : 'E-mail' }}</td>
                <td><span class="badge" :class="r.status">{{ statusLabel(r.status) }}</span></td>
              </tr>
              <tr v-if="openId === r.id" class="detail-row">
                <td colspan="4">
                  <div v-if="r.error" class="error-text">{{ r.error }}</div>
                  <div v-if="!detail">Carregando...</div>
                  <table v-else-if="detail.account_results?.length" class="data-table inner">
                    <thead><tr><th>Conta Snov.io</th><th>Lista</th><th>Enviados</th><th>Duplicados</th><th>Falhas</th></tr></thead>
                    <tbody>
                      <tr v-for="(a, i) in detail.account_results" :key="i">
                        <td>{{ a.account_label }}</td>
                        <td>{{ a.list_id }}</td>
                        <td>{{ a.added }}</td>
                        <td>{{ a.duplicates }}</td>
                        <td :class="{ 'error-text': a.failed || a.error }">{{ a.error || a.failed }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div v-else class="empty">Sem resultados por conta ainda.</div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import { useToast } from 'primevue/usetoast'
import { useRouter } from 'vue-router'
import { api } from '../services/api'
import { extractError } from '../services/errorMessage'

interface Run { id: number; started_at: string; status: string; value: string; kind: string; error: string | null }
interface RunDetail extends Run {
  account_results: { account_label: string; list_id: string | null; added: number; duplicates: number; failed: number; error: string | null }[]
}

const router = useRouter()
const toast = useToast()
const value = ref('')
const accountId = ref<string | null>(null)
const accounts = ref<{ id: string; emailAddress: string }[]>([])
const submitting = ref(false)
const runs = ref<Run[]>([])
const openId = ref<number | null>(null)
const detail = ref<RunDetail | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

async function loadRuns() {
  try {
    runs.value = (await api.get('/negativacao/runs')).data
    if (openId.value !== null) await loadDetail(openId.value)
  } catch { /* painel fora do ar: mantém lista anterior */ }
}

async function loadDetail(id: number) {
  try { detail.value = (await api.get(`/negativacao/runs/${id}`)).data } catch { /* idem */ }
}

async function toggle(id: number) {
  if (openId.value === id) { openId.value = null; detail.value = null; return }
  openId.value = id
  detail.value = null
  await loadDetail(id)
}

async function submit() {
  submitting.value = true
  try {
    await api.post('/negativacao/runs', { value: value.value, accountId: accountId.value })
    toast.add({ severity: 'success', summary: 'Negativação iniciada', detail: value.value.trim(), life: 4000 })
    value.value = ''
    setTimeout(loadRuns, 1500)
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Falha ao negativar', detail: extractError(err, 'Erro inesperado'), life: 6000 })
  } finally {
    submitting.value = false
  }
}

function statusLabel(s: string) {
  return ({ running: 'Em andamento', completed: 'Concluída', failed: 'Falhou' } as Record<string, string>)[s] ?? s
}

// O painel grava em UTC (datetime('now') do SQLite, sem fuso).
function formatDate(s: string) {
  return new Date(s.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

async function loadAccounts() {
  try {
    accounts.value = (await api.get('/accounts')).data
    if (accounts.value.length === 1) accountId.value = accounts.value[0].id
  } catch { /* select fica vazio */ }
}

onMounted(() => { loadAccounts(); loadRuns(); timer = setInterval(loadRuns, 10000) })
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.neg-layout { display: flex; flex-direction: column; height: 100vh; background: #f5f6fa; }
.neg-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: .5rem 1.2rem; background: #fff; border-bottom: 1px solid #e0e0e0; flex-shrink: 0;
}
.header-left { display: flex; align-items: center; gap: .8rem; }
.logo { font-weight: 700; font-size: 1.1rem; }
.logo-ativa { color: #111; }
.logo-ai { color: #F47A20; }
.neg-title { font-size: .85rem; color: #666; font-weight: 500; }
.neg-main { flex: 1; overflow-y: auto; padding: 1.2rem; max-width: 1000px; margin: 0 auto; width: 100%; }
.neg-card { background: #fff; border-radius: 10px; padding: 1.1rem 1.2rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); margin-bottom: 1.2rem; }
.neg-card h2 { font-size: 1rem; margin: 0 0 .4rem; color: #1a1a1a; }
.hint { font-size: .8rem; color: #888; margin: 0 0 .9rem; }
.neg-form { display: flex; gap: .6rem; flex-wrap: wrap; }
.neg-input { flex: 1; min-width: 240px; }
.neg-select { min-width: 240px; }
.empty { font-size: .85rem; color: #888; padding: .5rem 0; }
.data-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
.data-table th { text-align: left; color: #888; font-weight: 500; font-size: .75rem; text-transform: uppercase; padding: .4rem .5rem; }
.data-table td { padding: .5rem; border-top: 1px solid #eee; }
.clickable { cursor: pointer; }
.clickable:hover { background: #fafafa; }
.detail-row > td { background: #fafafa; }
.inner { background: #fff; }
.badge { padding: .15rem .5rem; border-radius: 999px; font-size: .72rem; font-weight: 600; background: #eee; color: #555; }
.badge.completed { background: #e6f4ea; color: #1e7e34; }
.badge.running { background: #fff4e0; color: #b26a00; }
.badge.failed { background: #fdecea; color: #c62828; }
.error-text { color: #c62828; font-size: .8rem; }
</style>
