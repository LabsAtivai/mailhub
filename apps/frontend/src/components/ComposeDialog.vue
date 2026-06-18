<template>
  <Dialog :visible="visible" @update:visible="$emit('update:visible', $event)"
    :header="isReply ? 'Responder' : 'Nova mensagem'" modal style="width:600px">

    <div class="form">
      <div class="field"><label>De</label>
        <Select v-model="form.accountId" :options="mail.accounts" option-label="emailAddress" option-value="id" fluid placeholder="Selecione a conta" /></div>

      <div class="field"><label>Para</label>
        <InputText v-model="form.to" fluid placeholder="destinatario@email.com" /></div>

      <div class="field"><label>Cc</label>
        <InputText v-model="form.cc" fluid /></div>

      <div class="field"><label>Assunto</label>
        <InputText v-model="form.subject" fluid /></div>

      <div class="field"><label>Mensagem</label>
        <Textarea v-model="form.body" rows="10" fluid auto-resize /></div>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    </div>

    <template #footer>
      <Button label="Cancelar" text @click="$emit('update:visible', false)" />
      <Button label="Enviar" icon="pi pi-send" :loading="sending" @click="send" />
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import { api } from '../services/api'
import { extractError } from '../services/errorMessage'
import { useMailStore } from '../stores/mail'

interface ReplyMessage {
  fromEmail?: string | null
  subject?: string | null
  date: string
  textBody?: string | null
  messageId?: string | null
}

const props = defineProps<{ visible: boolean; replyTo?: ReplyMessage | null }>()
const emit = defineEmits(['update:visible', 'sent'])
const mail = useMailStore()

const form = reactive({ accountId: '', to: '', cc: '', subject: '', body: '' })
const sending = ref(false); const error = ref('')
const isReply = ref(false)

watch(() => props.replyTo, (msg) => {
  if (!msg) { isReply.value = false; return }
  isReply.value = true
  form.accountId = mail.selectedAccountId || ''
  form.to = msg.fromEmail || ''
  form.subject = msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject || ''}`
  form.body = `\n\n--- Em ${new Date(msg.date).toLocaleString('pt-BR')}, ${msg.fromEmail} escreveu:\n${msg.textBody || ''}`
})

async function send() {
  error.value = ''; sending.value = true
  try {
    await api.post('/messages/send', {
      accountId: form.accountId,
      to: form.to.split(',').map(s => s.trim()).filter(Boolean),
      cc: form.cc ? form.cc.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      subject: form.subject,
      html: form.body.replace(/\n/g, '<br>'),
      text: form.body,
      inReplyTo: props.replyTo?.messageId,
    })
    emit('sent')
    emit('update:visible', false)
    Object.assign(form, { to: '', cc: '', subject: '', body: '' })
  } catch (e: unknown) {
    error.value = extractError(e, 'Erro ao enviar')
  } finally { sending.value = false }
}
</script>

<style scoped>
.form { display: flex; flex-direction: column; gap: .75rem; }
.field { display: flex; flex-direction: column; gap: .35rem; }
.field label { font-size: .8rem; font-weight: 500; }
</style>
