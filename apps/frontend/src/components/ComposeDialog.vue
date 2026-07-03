<template>
  <Dialog :visible="visible" @update:visible="$emit('update:visible', $event)"
    :header="isReply ? (props.replyAll ? 'Responder a todos' : 'Responder') : isForward ? 'Encaminhar' : 'Nova mensagem'" modal style="width:600px">

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

      <div class="field">
        <input type="file" ref="fileInputRef" multiple style="display:none" @change="onFilesSelected" />
        <Button label="Anexar arquivo" icon="pi pi-paperclip" text size="small"
          style="align-self:flex-start" @click="fileInputRef?.click()" />
        <div v-if="attachments.length > 0" class="attach-list">
          <div v-for="(att, idx) in attachments" :key="idx" class="attach-chip">
            <i class="pi pi-file"></i>
            <span class="attach-name">{{ att.name }}</span>
            <span class="attach-size">{{ formatSize(att.size) }}</span>
            <i class="pi pi-times remove-attach" @click="removeAttachment(idx)"></i>
          </div>
        </div>
      </div>

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

interface ComposeMessage {
  fromEmail?: string | null
  subject?: string | null
  date: string
  textBody?: string | null
  htmlBody?: string | null
  messageId?: string | null
  toJson?: string | null
  ccJson?: string | null
  attachments?: Array<{ filename: string; size: number }>
}

const props = defineProps<{
  visible: boolean
  replyTo?: ComposeMessage | null
  forwardMsg?: ComposeMessage | null
  replyAll?: boolean
}>()
const emit = defineEmits(['update:visible', 'sent'])
const mail = useMailStore()

const form = reactive({ accountId: '', to: '', cc: '', subject: '', body: '' })
const sending = ref(false); const error = ref('')
const isReply = ref(false)
const isForward = ref(false)
const attachments = ref<File[]>([])
const fileInputRef = ref<HTMLInputElement | null>(null)
const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

function onFilesSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  attachments.value = [...attachments.value, ...files]
  input.value = ''
}

function removeAttachment(idx: number) {
  attachments.value = attachments.value.filter((_, i) => i !== idx)
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function parseAddrs(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as Array<{ address?: string; name?: string }>
    return parsed.map(x => x.address || '').filter(Boolean)
  } catch { return [] }
}

watch(() => [props.replyTo, props.replyAll] as const, ([msg]) => {
  if (!msg) { isReply.value = false; return }
  isReply.value = true
  isForward.value = false
  form.accountId = mail.selectedAccountId || ''

  if (props.replyAll) {
    const ownEmail = mail.accounts.find(a => a.id === form.accountId)?.emailAddress?.toLowerCase() ?? ''
    const toAddrs = parseAddrs(msg.toJson)
    const ccAddrs = parseAddrs(msg.ccJson)
    const replyToAddrs = msg.fromEmail ? [msg.fromEmail] : []
    const toAll = [...new Set([...replyToAddrs, ...toAddrs].filter(e => e.toLowerCase() !== ownEmail))]
    const ccAll = [...new Set(ccAddrs.filter(e => e.toLowerCase() !== ownEmail))]
    form.to = toAll.join(', ')
    form.cc = ccAll.join(', ')
  } else {
    form.to = msg.fromEmail || ''
    form.cc = ''
  }

  form.subject = msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject || ''}`
  form.body = `\n\n--- Em ${new Date(msg.date).toLocaleString('pt-BR')}, ${msg.fromEmail} escreveu:\n${msg.textBody || ''}`
})

watch(() => props.forwardMsg, (msg) => {
  if (!msg) { isForward.value = false; return }
  isForward.value = true
  isReply.value = false
  form.accountId = mail.selectedAccountId || ''
  form.to = ''
  form.subject = msg.subject?.startsWith('Fwd:') ? msg.subject : `Fwd: ${msg.subject || ''}`
  form.body = `\n\n---------- Mensagem encaminhada ----------\nDe: ${msg.fromEmail || ''}\nData: ${new Date(msg.date).toLocaleString('pt-BR')}\nAssunto: ${msg.subject || ''}\n\n${msg.textBody || ''}`
})

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function send() {
  if (!form.accountId) { error.value = 'Selecione uma conta'; return }
  if (!form.to.trim()) { error.value = 'Destinatário obrigatório'; return }
  const totalBytes = attachments.value.reduce((sum, f) => sum + f.size, 0)
  if (totalBytes > MAX_ATTACHMENTS_BYTES) { error.value = 'Anexos excedem o limite de 20MB'; return }
  error.value = ''; sending.value = true
  try {
    const encodedAttachments = await Promise.all(attachments.value.map(async f => ({
      filename: f.name,
      mimeType: f.type || undefined,
      content: await fileToBase64(f),
    })))
    await api.post('/messages/send', {
      accountId: form.accountId,
      to: form.to.split(',').map(s => s.trim()).filter(Boolean),
      cc: form.cc ? form.cc.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      subject: form.subject,
      html: escapeHtml(form.body).replace(/\n/g, '<br>'),
      text: form.body,
      inReplyTo: props.replyTo?.messageId ?? props.forwardMsg?.messageId,
      attachments: encodedAttachments.length > 0 ? encodedAttachments : undefined,
    })
    emit('sent')
    emit('update:visible', false)
    Object.assign(form, { to: '', cc: '', subject: '', body: '' })
    attachments.value = []
  } catch (e: unknown) {
    error.value = extractError(e, 'Erro ao enviar')
  } finally { sending.value = false }
}
</script>

<style scoped>
.form { display: flex; flex-direction: column; gap: .75rem; }
.field { display: flex; flex-direction: column; gap: .35rem; }
.field label { font-size: .8rem; font-weight: 500; }
.attach-list { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .3rem; }
.attach-chip {
  display: inline-flex; align-items: center; gap: .35rem;
  background: var(--p-surface-50); border: 1px solid var(--p-surface-200);
  border-radius: 8px; padding: .3rem .6rem; font-size: .78rem; max-width: 260px;
}
.attach-chip i.pi-file { font-size: .75rem; color: var(--p-text-muted-color); }
.attach-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
.attach-size { color: var(--p-text-muted-color); white-space: nowrap; font-size: .7rem; }
.remove-attach { cursor: pointer; font-size: .7rem; color: var(--p-text-muted-color); }
.remove-attach:hover { color: var(--p-red-500); }
</style>
