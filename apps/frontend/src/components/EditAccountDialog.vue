<template>
  <Dialog :visible="visible" @update:visible="$emit('update:visible', $event)"
    header="Editar conta de e-mail" modal style="width:500px" :closable="true">

    <div class="form">
      <div class="field">
        <label>Nome de exibição *</label>
        <InputText v-model="form.displayName" fluid placeholder="Ex: MKT Roberto Aksum" />
      </div>

      <div class="field">
        <label>E-mail da conta *</label>
        <InputText v-model="form.emailAddress" type="email" fluid />
      </div>

      <div class="field">
        <label>Usuário IMAP *</label>
        <InputText v-model="form.username" fluid />
      </div>

      <div class="field">
        <label>Senha</label>
        <Password v-model="form.password" :feedback="false" toggleMask fluid
          placeholder="Deixar em branco para não alterar" />
      </div>

      <div class="row">
        <div class="field flex-1">
          <label>Servidor IMAP *</label>
          <InputText v-model="form.incomingHost" fluid />
        </div>
        <div class="field w80">
          <label>Porta</label>
          <InputText :model-value="String(form.incomingPort)"
            @update:model-value="form.incomingPort = Number($event) || 993" fluid />
        </div>
      </div>

      <div class="row">
        <div class="field flex-1">
          <label>Servidor SMTP *</label>
          <InputText v-model="form.outgoingHost" fluid />
        </div>
        <div class="field w80">
          <label>Porta</label>
          <InputText :model-value="String(form.outgoingPort)"
            @update:model-value="form.outgoingPort = Number($event) || 465" fluid />
        </div>
      </div>

      <div class="field">
        <label>Segurança</label>
        <Select v-model="form.tlsMode" :options="tlsOptions"
          option-label="label" option-value="value" fluid />
      </div>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    </div>

    <template #footer>
      <div class="footer-left">
        <Button v-if="!confirmDelete" label="Remover conta" text severity="danger" @click="confirmDelete = true" />
        <template v-else>
          <span class="confirm-text">Tem certeza?</span>
          <Button label="Sim, remover" severity="danger" size="small" :loading="deleting" @click="remove" />
          <Button label="Cancelar" text size="small" @click="confirmDelete = false" />
        </template>
      </div>
      <Button label="Cancelar" text @click="$emit('update:visible', false)" />
      <Button label="Salvar" :loading="saving" @click="save" />
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Select from 'primevue/select'
import { api } from '../services/api'
import { extractError } from '../services/errorMessage'
import type { MailAccount } from '../stores/mail'

const props = defineProps<{ visible: boolean; account: MailAccount | null }>()
const emit = defineEmits(['update:visible', 'saved'])

const tlsOptions = [
  { label: 'TLS (porta 993 IMAP / 465 SMTP)', value: 'TLS' },
  { label: 'STARTTLS (porta 143 IMAP / 587 SMTP)', value: 'STARTTLS' },
]

const form = reactive({
  displayName: '', emailAddress: '', username: '', password: '',
  incomingHost: '', incomingPort: 993,
  outgoingHost: '', outgoingPort: 465,
  tlsMode: 'TLS',
})

const saving = ref(false)
const deleting = ref(false)
const confirmDelete = ref(false)
const error = ref('')

watch(() => props.visible, () => { confirmDelete.value = false; error.value = '' })

watch(() => props.account, (acc) => {
  if (!acc) return
  Object.assign(form, {
    displayName: acc.displayName,
    emailAddress: acc.emailAddress,
    username: acc.username,
    password: '',
    incomingHost: acc.incomingHost,
    incomingPort: acc.incomingPort,
    outgoingHost: acc.outgoingHost,
    outgoingPort: acc.outgoingPort,
    tlsMode: acc.tlsMode,
  })
  error.value = ''
}, { immediate: true })

async function remove() {
  if (!props.account) return
  deleting.value = true
  try {
    await api.delete(`/accounts/${props.account.id}`)
    emit('update:visible', false)
    emit('saved')
  } catch (e: unknown) {
    error.value = extractError(e, 'Erro ao remover conta')
    confirmDelete.value = false
  } finally {
    deleting.value = false
  }
}

async function save() {
  if (!props.account) return
  error.value = ''
  saving.value = true
  try {
    const payload: Record<string, unknown> = {
      displayName: form.displayName,
      emailAddress: form.emailAddress,
      username: form.username,
      incomingHost: form.incomingHost,
      incomingPort: form.incomingPort,
      outgoingHost: form.outgoingHost,
      outgoingPort: form.outgoingPort,
      tlsMode: form.tlsMode,
    }
    if (form.password) payload.password = form.password
    await api.patch(`/accounts/${props.account.id}`, payload)
    emit('update:visible', false)
    emit('saved')
  } catch (e: unknown) {
    error.value = extractError(e, 'Erro ao salvar')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.form { display: flex; flex-direction: column; gap: .75rem; }
.field { display: flex; flex-direction: column; gap: .35rem; }
.field label { font-size: .8rem; font-weight: 500; }
.row { display: flex; gap: .75rem; align-items: flex-end; }
.flex-1 { flex: 1; }
.w80 { width: 80px; }
.footer-left { flex: 1; display: flex; align-items: center; gap: .4rem; }
.confirm-text { font-size: .82rem; color: var(--p-red-600); font-weight: 500; }
</style>
