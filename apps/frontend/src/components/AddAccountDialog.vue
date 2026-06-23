<template>
  <Dialog :visible="visible" @update:visible="$emit('update:visible', $event)"
    header="Adicionar conta de e-mail" modal style="width:500px" :closable="true">

    <div class="form">
      <div class="field">
        <label>Nome de exibição *</label>
        <InputText v-model="form.displayName" fluid placeholder="Ex: MKT Roberto Aksum" />
      </div>

      <div class="field">
        <label>E-mail da conta *</label>
        <InputText v-model="form.emailAddress" type="email" fluid placeholder="roberto@dominio.com"
          @blur="autoFillUsername" />
      </div>

      <div class="field">
        <label>Usuário IMAP *</label>
        <InputText v-model="form.username" fluid placeholder="Geralmente o mesmo e-mail" />
      </div>

      <div class="field">
        <label>Senha *</label>
        <Password v-model="form.password" :feedback="false" toggleMask fluid />
      </div>

      <div class="row">
        <div class="field flex-1">
          <label>Servidor IMAP *</label>
          <InputText v-model="form.incomingHost" fluid placeholder="mail.dominio.com"
            @blur="autoFillOutgoing" />
        </div>
        <div class="field w80">
          <label>Porta</label>
          <InputText :model-value="String(form.incomingPort)" @update:model-value="form.incomingPort = Number($event) || 993" fluid />
        </div>
      </div>

      <div class="row">
        <div class="field flex-1">
          <label>Servidor SMTP *</label>
          <InputText v-model="form.outgoingHost" fluid placeholder="Igual ao IMAP" />
        </div>
        <div class="field w80">
          <label>Porta</label>
          <InputText :model-value="String(form.outgoingPort)" @update:model-value="form.outgoingPort = Number($event) || 465" fluid />
        </div>
      </div>

      <div class="field">
        <label>Segurança</label>
        <Select v-model="form.tlsMode" :options="tlsOptions"
          option-label="label" option-value="value" fluid />
      </div>

      <div v-if="testResult === 'ok'" class="status-ok">
        <i class="pi pi-check-circle"></i> Conexão bem-sucedida — pode salvar
      </div>
      <Message v-if="testResult === 'error'" severity="error" :closable="false">{{ testError }}</Message>
    </div>

    <template #footer>
      <Button label="Testar conexão" text :loading="testing" @click="testConn" />
      <Button label="Salvar" :loading="saving" :disabled="testResult !== 'ok'" @click="save" />
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Select from 'primevue/select'
import { api } from '../services/api'
import { extractError } from '../services/errorMessage'

defineProps<{ visible: boolean }>()
const emit = defineEmits(['update:visible', 'added'])

const form = reactive({
  displayName: '', emailAddress: '', username: '', password: '',
  incomingHost: '', incomingPort: 993,
  outgoingHost: '', outgoingPort: 465,
  tlsMode: 'TLS',
})

const tlsOptions = [
  { label: 'TLS (porta 993 IMAP / 465 SMTP)', value: 'TLS' },
  { label: 'STARTTLS (porta 143 IMAP / 587 SMTP)', value: 'STARTTLS' },
]

const testing = ref(false)
const saving = ref(false)
const testResult = ref<'ok' | 'error' | null>(null)
const testError = ref('')

// auto-fill helpers
function autoFillUsername() {
  if (!form.username && form.emailAddress) form.username = form.emailAddress
}
function autoFillOutgoing() {
  if (!form.outgoingHost && form.incomingHost) form.outgoingHost = form.incomingHost
}

async function testConn() {
  testResult.value = null
  testing.value = true
  try {
    await api.post('/accounts/test', { ...form })
    testResult.value = 'ok'
  } catch (e: unknown) {
    testResult.value = 'error'
    testError.value = extractError(e, 'Falha na conexão IMAP')
  } finally { testing.value = false }
}

async function save() {
  saving.value = true
  try {
    await api.post('/accounts', { ...form })
    emit('update:visible', false)
    emit('added')
    // reset
    Object.assign(form, {
      displayName: '', emailAddress: '', username: '', password: '',
      incomingHost: '', incomingPort: 993, outgoingHost: '', outgoingPort: 465, tlsMode: 'TLS'
    })
    testResult.value = null
  } catch (e: unknown) {
    testResult.value = 'error'
    testError.value = extractError(e, 'Erro ao salvar')
  } finally { saving.value = false }
}
</script>

<style scoped>
.form { display: flex; flex-direction: column; gap: .75rem; }
.field { display: flex; flex-direction: column; gap: .35rem; }
.field label { font-size: .8rem; font-weight: 500; }
.row { display: flex; gap: .75rem; align-items: flex-end; }
.flex-1 { flex: 1; }
.w80 { width: 80px; }
.status-ok { display: flex; align-items: center; gap: .5rem; color: #25D366; font-size: .875rem; padding: .5rem; background: #f0fdf4; border-radius: 6px; }
</style>
