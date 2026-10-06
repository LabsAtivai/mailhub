<template>
  <Dialog :visible="visible" @update:visible="$emit('update:visible', $event)"
    header="Contexto de clientes (IA)" modal style="width:560px">

    <p class="hint">
      Cadastre o questionário/kickoff de cada cliente pelo domínio do e-mail dele.
      A IA usa esse conteúdo com prioridade máxima ao gerar respostas pra qualquer
      contato desse domínio.
    </p>

    <div class="form-section">
      <div class="field">
        <label>{{ editing ? 'Editar cliente' : 'Novo cliente' }}</label>
        <InputText v-model="form.domain" fluid placeholder="dominio-do-cliente.com.br" :disabled="!!editing" />
      </div>
      <div class="field">
        <label>Nome do cliente</label>
        <AutoComplete v-model="form.clientName" :suggestions="nameSuggestions" @complete="searchClientName"
          option-label="clientName" fluid placeholder="Ex: Empresa Exemplo Ltda"
          @item-select="onSelectExisting" />
        <span v-if="!editing" class="field-hint">Digite pra ver clientes já cadastrados e linkar o material a eles, em vez de duplicar.</span>
      </div>
      <div class="field">
        <label>Questionário / kickoff</label>
        <Textarea v-model="form.content" rows="6" fluid auto-resize
          placeholder="Escopo combinado, plano contratado, restrições (ex: não oferecer demonstração), pontos de contato..." />
      </div>

      <Message v-if="formError" severity="error" :closable="false">{{ formError }}</Message>

      <div class="form-actions">
        <Button v-if="editing" label="Cancelar" text @click="cancelEdit" />
        <Button :label="editing ? 'Salvar alterações' : 'Adicionar cliente'"
          :icon="editing ? 'pi pi-check' : 'pi pi-plus'"
          :loading="submitting" @click="submit" />
      </div>
    </div>

    <Divider />

    <div class="list">
      <div v-if="loading" class="loading-row">
        <Skeleton v-for="n in 2" :key="n" height="3rem" class="mb-2" />
      </div>
      <div v-else-if="profiles.length === 0" class="empty">
        <i class="pi pi-building" style="font-size:1.5rem;opacity:.3"></i>
        <span>Nenhum cliente cadastrado ainda</span>
      </div>
      <div v-for="p in profiles" :key="p.id" class="profile-row">
        <div class="profile-info">
          <span class="profile-name">{{ p.clientName }}</span>
          <span class="profile-domain">{{ p.domain }}</span>
        </div>
        <div class="profile-actions">
          <Button icon="pi pi-history" text rounded size="small" v-tooltip="'Rodar backfill (aprender com Sent antigo desse domínio)'"
            :loading="backfillingId === p.id" @click="runBackfill(p)" />
          <Button icon="pi pi-pencil" text rounded size="small" v-tooltip="'Editar'" @click="startEdit(p)" />
          <Button icon="pi pi-trash" text rounded size="small" severity="danger" v-tooltip="'Excluir'" @click="confirmDelete(p)" />
        </div>
      </div>
      <Message v-if="backfillResult" severity="success" :closable="true" @close="backfillResult = ''">{{ backfillResult }}</Message>
    </div>

    <ConfirmDialog group="clientProfiles" />
  </Dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Divider from 'primevue/divider'
import AutoComplete from 'primevue/autocomplete'
import Skeleton from 'primevue/skeleton'
import ConfirmDialog from 'primevue/confirmdialog'
import { useConfirm } from 'primevue/useconfirm'
import { api } from '../services/api'
import { extractError } from '../services/errorMessage'

interface ClientProfile {
  id: string
  domain: string
  clientName: string
  content: string
}

const props = defineProps<{ visible: boolean; accountId: string | null }>()
const emit = defineEmits(['update:visible'])
const confirm = useConfirm()

const profiles = ref<ClientProfile[]>([])
const loading = ref(false)
const submitting = ref(false)
const formError = ref('')
const editing = ref<ClientProfile | null>(null)
const form = reactive({ domain: '', clientName: '', content: '' })
const nameSuggestions = ref<ClientProfile[]>([])
const backfillingId = ref<string | null>(null)
const backfillResult = ref('')

function searchClientName(e: { query: string }) {
  const q = e.query.trim().toLowerCase()
  nameSuggestions.value = !q
    ? profiles.value
    : profiles.value.filter(p => p.clientName.toLowerCase().includes(q))
}

function onSelectExisting(e: { value: ClientProfile }) {
  startEdit(e.value)
}

async function runBackfill(p: ClientProfile) {
  if (!props.accountId) return
  backfillResult.value = ''
  backfillingId.value = p.id
  try {
    const { data } = await api.post(`/accounts/${props.accountId}/clients/${p.id}/backfill`)
    backfillResult.value = `${p.clientName}: ${data.embeddedNow} indexado(s) agora, ${data.queuedForBody} aguardando busca de corpo (${data.candidates} encontrados no total).`
  } catch (e: unknown) {
    formError.value = extractError(e, 'Erro ao rodar backfill')
  } finally {
    backfillingId.value = null
  }
}

function resetForm() {
  form.domain = ''; form.clientName = ''; form.content = ''
  editing.value = null
  formError.value = ''
}

async function load() {
  if (!props.accountId) return
  loading.value = true
  try {
    const { data } = await api.get(`/accounts/${props.accountId}/clients`)
    profiles.value = data
  } catch (e: unknown) {
    formError.value = extractError(e, 'Erro ao carregar clientes')
  } finally {
    loading.value = false
  }
}

watch(() => [props.visible, props.accountId] as const, ([visible]) => {
  if (visible) { resetForm(); load() }
})

function startEdit(p: ClientProfile) {
  editing.value = p
  form.domain = p.domain
  form.clientName = p.clientName
  form.content = p.content
  formError.value = ''
}

function cancelEdit() { resetForm() }

async function submit() {
  if (!props.accountId) return
  if (!form.domain.trim()) { formError.value = 'Domínio obrigatório'; return }
  if (!form.clientName.trim()) { formError.value = 'Nome do cliente obrigatório'; return }
  formError.value = ''
  submitting.value = true
  try {
    await api.put(`/accounts/${props.accountId}/clients`, {
      domain: form.domain.trim(),
      clientName: form.clientName.trim(),
      content: form.content,
    })
    resetForm()
    await load()
  } catch (e: unknown) {
    formError.value = extractError(e, 'Erro ao salvar')
  } finally {
    submitting.value = false
  }
}

function confirmDelete(p: ClientProfile) {
  confirm.require({
    group: 'clientProfiles',
    message: `Excluir o contexto de "${p.clientName}" (${p.domain})?`,
    header: 'Confirmar exclusão',
    icon: 'pi pi-trash',
    acceptClass: 'p-button-danger',
    acceptLabel: 'Excluir',
    rejectLabel: 'Cancelar',
    accept: async () => {
      if (!props.accountId) return
      await api.delete(`/accounts/${props.accountId}/clients/${p.id}`)
      if (editing.value?.id === p.id) resetForm()
      await load()
    },
  })
}
</script>

<style scoped>
.hint { font-size: .8rem; color: var(--p-text-muted-color); margin: 0 0 .75rem; line-height: 1.4; }
.form-section { display: flex; flex-direction: column; gap: .75rem; }
.field { display: flex; flex-direction: column; gap: .35rem; }
.field label { font-size: .8rem; font-weight: 500; }
.field-hint { font-size: .72rem; color: var(--p-text-muted-color); }
.form-actions { display: flex; justify-content: flex-end; gap: .5rem; }

.list { display: flex; flex-direction: column; gap: .4rem; max-height: 260px; overflow-y: auto; }
.loading-row { display: flex; flex-direction: column; gap: .4rem; }
.empty { display: flex; flex-direction: column; align-items: center; gap: .5rem; padding: 1.5rem; color: var(--p-text-muted-color); font-size: .875rem; }
.profile-row {
  display: flex; align-items: center; justify-content: space-between; gap: .5rem;
  padding: .5rem .75rem; border-radius: 8px;
  background: var(--p-surface-50); border: 1px solid var(--p-surface-200);
}
.profile-info { display: flex; flex-direction: column; min-width: 0; }
.profile-name { font-size: .875rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.profile-domain { font-size: .75rem; color: var(--p-text-muted-color); }
.profile-actions { display: flex; gap: .1rem; flex-shrink: 0; }
</style>
