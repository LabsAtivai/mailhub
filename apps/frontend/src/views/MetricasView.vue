<template>
  <div class="met-layout">
    <header class="met-header">
      <div class="header-left">
        <span class="logo"><span class="logo-ativa">ATIVA</span><span class="logo-ai">.ai</span></span>
        <span class="met-title"><i class="pi pi-android"></i> Métricas</span>
      </div>
      <div class="header-right">
        <Button icon="pi pi-inbox" text size="small" label="MailHub" @click="router.push('/')" />
      </div>
    </header>

    <main class="met-main">
      <section class="met-card">
        <div class="filters">
          <Select v-model="accountId" :options="accounts" optionValue="id" optionLabel="emailAddress"
            placeholder="Caixa" class="met-select" @change="load" />
          <Select v-model="days" :options="periods" optionValue="value" optionLabel="label"
            class="met-period" @change="load" />
          <span v-if="data" class="mode-badge" :class="data.mode">{{ modeLabel(data.mode) }}</span>
        </div>
        <p v-if="data && data.mode === 'off'" class="hint">
          O agente de resposta está desligado nesta caixa. Peça a um administrador para ativá-lo.
        </p>
        <p v-if="data && data.mode === 'test'" class="hint">
          Modo teste: as respostas do agente são enviadas só para o endereço de teste, nunca para o lead.
        </p>
      </section>

      <section v-if="readiness" class="met-card">
        <h2>Prontidão para produção</h2>
        <p class="hint ready-line">
          <span class="ready-badge" :class="readiness.ok ? 'ok' : 'blocked'">
            {{ readiness.ok ? 'Pronta para o modo ao vivo' : `${readiness.blockers.length} bloqueio(s) para o modo ao vivo` }}
          </span>
          {{ readiness.stats.drafts }} rascunhos · {{ readiness.stats.testSent }} respostas de teste · {{ readiness.stats.chunks }} trechos na base
        </p>
        <ul v-if="readiness.blockers.length" class="ready-list blockers">
          <li v-for="b in readiness.blockers" :key="b.code + b.message">{{ b.message }}</li>
        </ul>
        <ul v-if="readiness.warnings.length" class="ready-list warnings">
          <li v-for="w in readiness.warnings" :key="w.code + w.message">{{ w.message }}</li>
        </ul>
      </section>

      <div v-if="error" class="met-card error-text">{{ error }}</div>
      <div v-else-if="loading && !data" class="met-card empty">Carregando...</div>

      <template v-if="data">
        <section class="cards">
          <div class="stat">
            <div class="stat-label">Respostas do agente</div>
            <div class="stat-value">{{ data.agent.replies }}</div>
            <div class="stat-sub">enviadas no período</div>
          </div>
          <div class="stat">
            <div class="stat-label">Interessados</div>
            <div class="stat-value accent">{{ data.interested }}</div>
            <div class="stat-sub">{{ pct(data.interested, data.agent.replies) }} das respondidas</div>
          </div>
          <div class="stat">
            <div class="stat-label">Responderam</div>
            <div class="stat-value">{{ data.replied }}</div>
            <div class="stat-sub">{{ pct(data.replied, data.agent.replies) }} das respondidas</div>
          </div>
          <div class="stat">
            <div class="stat-label">Com apresentação</div>
            <div class="stat-value">{{ data.withAttachment }}</div>
            <div class="stat-sub">{{ pct(data.withAttachment, data.agent.replies) }} das respondidas</div>
          </div>
          <div class="stat">
            <div class="stat-label">Rascunhos (sombra)</div>
            <div class="stat-value">{{ data.agent.shadow }}</div>
            <div class="stat-sub">gerados sem envio</div>
          </div>
          <div class="stat">
            <div class="stat-label">Ignoradas</div>
            <div class="stat-value">{{ data.agent.skipped }}</div>
            <div class="stat-sub">{{ skippedText }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Erros</div>
            <div class="stat-value" :class="{ danger: data.agent.errors > 0 }">{{ data.agent.errors }}</div>
            <div class="stat-sub">falhas de geração ou envio</div>
          </div>
        </section>

        <section class="met-card">
          <h2>Triagem das respostas recebidas</h2>
          <p class="hint">Classificação do relatório diário sobre a caixa de entrada no período.</p>
          <div class="cards small">
            <div v-for="s in statusOrder" :key="s.key" class="stat">
              <div class="stat-label">{{ s.label }}</div>
              <div class="stat-value">{{ data.leadStatus[s.key] ?? 0 }}</div>
            </div>
          </div>
        </section>

        <section class="met-card">
          <h2>Últimas respostas do agente</h2>
          <div v-if="!data.recent.length" class="empty">Nenhuma ainda.</div>
          <table v-else class="data-table">
            <thead><tr><th>Quando</th><th>Lead</th><th>Status</th></tr></thead>
            <tbody>
              <template v-for="r in data.recent" :key="r.id">
                <tr class="clickable" @click="openId = openId === r.id ? null : r.id">
                  <td>{{ formatDate(r.at) }}</td>
                  <td>{{ r.fromEmail }}</td>
                  <td>
                    <span class="badge" :class="r.status">{{ statusLabel(r) }}</span>
                    <span v-if="r.attachment" class="badge attach" :title="r.attachment"><i class="pi pi-paperclip"></i> PDF</span>
                  </td>
                </tr>
                <tr v-if="openId === r.id && r.draft" class="detail-row">
                  <td colspan="3"><pre class="draft">{{ r.draft }}</pre></td>
                </tr>
              </template>
            </tbody>
          </table>
        </section>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Button from 'primevue/button'
import Select from 'primevue/select'
import { useRouter } from 'vue-router'
import { api } from '../services/api'
import { extractError } from '../services/errorMessage'

interface Recent { id: string; at: string; fromEmail: string; status: string; reason: string | null; draft: string | null; attachment: string | null }
interface Finding { code: string; message: string }
interface Readiness {
  ok: boolean
  blockers: Finding[]
  warnings: Finding[]
  stats: { chunks: number; sources: number; drafts: number; testSent: number; errors: number }
}
interface Metrics {
  mode: string
  agent: { replies: number; shadow: number; skipped: number; errors: number; skippedByReason: Record<string, number> }
  withAttachment: number
  interested: number
  replied: number
  replyRate: number
  leadStatus: Record<string, number>
  recent: Recent[]
}

const router = useRouter()
const accounts = ref<{ id: string; emailAddress: string }[]>([])
const accountId = ref<string | null>(null)
const days = ref(30)
const data = ref<Metrics | null>(null)
const readiness = ref<Readiness | null>(null)
const loading = ref(false)
const error = ref('')
const openId = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

const periods = [
  { label: 'Últimos 7 dias', value: 7 },
  { label: 'Últimos 30 dias', value: 30 },
  { label: 'Últimos 90 dias', value: 90 },
]

const statusOrder = [
  { key: 'interessado', label: 'Interessados' },
  { key: 'apresentacao', label: 'Apresentação' },
  { key: 'encaminhamento', label: 'Encaminhamento' },
  { key: 'negado', label: 'Negados' },
  { key: 'automatico', label: 'Automáticos' },
  { key: 'outro', label: 'Outros' },
]

const reasonLabels: Record<string, string> = {
  self: 'própria caixa', automatic: 'automática', noreply: 'noreply/bounce', opt_out: 'descadastro',
  empty: 'sem conteúdo', thread_recent: 'thread já respondida', daily_limit: 'limite diário', no_reply_needed: 'não precisa resposta',
}

const skippedText = computed(() => {
  const r = data.value?.agent.skippedByReason ?? {}
  const parts = Object.entries(r).map(([k, v]) => `${v} ${reasonLabels[k] ?? k}`)
  return parts.length ? parts.join(' · ') : 'nenhuma'
})

function pct(n: number, total: number) {
  return total ? `${Math.round((n / total) * 100)}%` : '—'
}

function modeLabel(m: string) {
  return ({ off: 'Desligado', shadow: 'Sombra', test: 'Teste', live: 'Ao vivo' } as Record<string, string>)[m] ?? m
}

function statusLabel(r: Recent) {
  const base = ({
    sent: 'Enviada', test_sent: 'Enviada (teste)', shadow: 'Rascunho', skipped: 'Ignorada', error: 'Erro', processing: 'Processando',
  } as Record<string, string>)[r.status] ?? r.status
  return r.status === 'skipped' && r.reason ? `${base}: ${reasonLabels[r.reason] ?? r.reason}` : base
}

function formatDate(s: string) {
  return new Date(s).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

async function load() {
  if (!accountId.value) return
  loading.value = true
  try {
    const [m, r] = await Promise.all([
      api.get(`/accounts/${accountId.value}/auto-reply/metrics`, { params: { days: days.value } }),
      api.get(`/accounts/${accountId.value}/auto-reply/readiness`),
    ])
    data.value = m.data
    readiness.value = r.data
    error.value = ''
  } catch (err) {
    error.value = extractError(err, 'Não foi possível carregar as métricas')
  } finally {
    loading.value = false
  }
}

async function loadAccounts() {
  try {
    accounts.value = (await api.get('/accounts')).data
    if (accounts.value.length) accountId.value = accounts.value[0].id
  } catch { /* select fica vazio */ }
  await load()
}

onMounted(() => { loadAccounts(); timer = setInterval(load, 30000) })
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.met-layout { display: flex; flex-direction: column; height: 100vh; background: #f5f6fa; }
.met-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: .5rem 1.2rem; background: #fff; border-bottom: 1px solid #e0e0e0; flex-shrink: 0;
}
.header-left { display: flex; align-items: center; gap: .8rem; }
.logo { font-weight: 700; font-size: 1.1rem; }
.logo-ativa { color: #111; }
.logo-ai { color: #F47A20; }
.met-title { font-size: .85rem; color: #666; font-weight: 500; display: flex; align-items: center; gap: .4rem; }
.met-main { flex: 1; overflow-y: auto; padding: 1.2rem; max-width: 1000px; margin: 0 auto; width: 100%; }
.met-card { background: #fff; border-radius: 10px; padding: 1.1rem 1.2rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); margin-bottom: 1.2rem; }
.met-card h2 { font-size: 1rem; margin: 0 0 .4rem; color: #1a1a1a; }
.hint { font-size: .8rem; color: #888; margin: .6rem 0 0; }
.filters { display: flex; gap: .6rem; flex-wrap: wrap; align-items: center; }
.met-select { min-width: 260px; }
.met-period { min-width: 160px; }
.mode-badge { padding: .15rem .6rem; border-radius: 999px; font-size: .72rem; font-weight: 600; background: #eee; color: #555; }
.mode-badge.live { background: #e6f4ea; color: #1e7e34; }
.mode-badge.test { background: #fff4e0; color: #b26a00; }
.mode-badge.shadow { background: #e8f0fe; color: #1a56c4; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: .8rem; margin-bottom: 1.2rem; }
.cards.small { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); margin: .8rem 0 0; }
.stat { background: #fff; border-radius: 10px; padding: .9rem 1rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.cards.small .stat { box-shadow: none; border: 1px solid #eee; }
.stat-label { font-size: .75rem; color: #888; text-transform: uppercase; font-weight: 500; }
.stat-value { font-size: 1.7rem; font-weight: 700; color: #1a1a1a; margin: .2rem 0; }
.stat-value.accent { color: #F47A20; }
.stat-value.danger { color: #c62828; }
.stat-sub { font-size: .75rem; color: #888; }
.empty { font-size: .85rem; color: #888; padding: .5rem 0; }
.data-table { width: 100%; border-collapse: collapse; font-size: .85rem; margin-top: .4rem; }
.data-table th { text-align: left; color: #888; font-weight: 500; font-size: .75rem; text-transform: uppercase; padding: .4rem .5rem; }
.data-table td { padding: .5rem; border-top: 1px solid #eee; }
.clickable { cursor: pointer; }
.clickable:hover { background: #fafafa; }
.detail-row > td { background: #fafafa; }
.draft { margin: 0; white-space: pre-wrap; font-family: inherit; font-size: .82rem; color: #333; }
.badge { padding: .15rem .5rem; border-radius: 999px; font-size: .72rem; font-weight: 600; background: #eee; color: #555; }
.badge.sent, .badge.test_sent { background: #e6f4ea; color: #1e7e34; }
.badge.shadow { background: #e8f0fe; color: #1a56c4; }
.badge.attach { margin-left: .3rem; background: #fff4e0; color: #b26a00; }
.badge.error { background: #fdecea; color: #c62828; }
.error-text { color: #c62828; font-size: .85rem; }
.ready-line { display: flex; gap: .6rem; flex-wrap: wrap; align-items: center; }
.ready-badge { padding: .15rem .6rem; border-radius: 999px; font-size: .72rem; font-weight: 600; }
.ready-badge.ok { background: #e6f4ea; color: #1e7e34; }
.ready-badge.blocked { background: #fdecea; color: #c62828; }
.ready-list { margin: .5rem 0 0; padding-left: 1.1rem; font-size: .82rem; }
.ready-list.blockers { color: #c62828; }
.ready-list.warnings { color: #b26a00; }
</style>
