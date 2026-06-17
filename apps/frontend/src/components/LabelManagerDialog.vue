<template>
  <Dialog :visible="visible" @update:visible="$emit('update:visible', $event)"
    header="Gerenciar Etiquetas" modal style="width:480px">

    <!-- create / edit form -->
    <div class="form-section">
      <div class="form-row">
        <div class="field flex-1">
          <label>{{ editing ? 'Editar etiqueta' : 'Nova etiqueta' }}</label>
          <InputText v-model="form.name" fluid placeholder="Nome da etiqueta" maxlength="40"
            @keydown.enter="submit" />
        </div>
        <div class="field">
          <label>Cor</label>
          <div class="color-picker-wrap">
            <input type="color" v-model="form.color" class="color-input" />
            <div class="color-preview" :style="{ background: form.color }"></div>
          </div>
        </div>
      </div>

      <div class="preset-colors">
        <button v-for="c in presetColors" :key="c"
          class="preset-dot" :style="{ background: c }"
          :class="{ active: form.color === c }"
          @click="form.color = c"
          :title="c" />
      </div>

      <Message v-if="formError" severity="error" :closable="false" class="mt-1">{{ formError }}</Message>

      <div class="form-actions">
        <Button v-if="editing" label="Cancelar" text @click="cancelEdit" />
        <Button :label="editing ? 'Salvar alterações' : 'Criar etiqueta'"
          :icon="editing ? 'pi pi-check' : 'pi pi-plus'"
          :loading="submitting"
          @click="submit" />
      </div>
    </div>

    <Divider />

    <!-- labels list -->
    <div class="labels-list">
      <div v-if="labelStore.loading" class="loading-row">
        <Skeleton v-for="n in 3" :key="n" height="2.5rem" class="mb-2" />
      </div>

      <div v-else-if="labelStore.labels.length === 0" class="empty-labels">
        <i class="pi pi-tag" style="font-size:1.5rem;opacity:.3"></i>
        <span>Nenhuma etiqueta criada ainda</span>
      </div>

      <TransitionGroup name="label-list" tag="div">
        <div v-for="label in labelStore.labels" :key="label.id" class="label-row">
          <div class="label-dot" :style="{ background: label.color }"></div>
          <span class="label-name">{{ label.name }}</span>
          <span class="label-count">{{ label.messageCount }} msg</span>
          <div class="label-actions">
            <Button icon="pi pi-pencil" text rounded size="small"
              v-tooltip="'Editar'" @click="startEdit(label)" />
            <Button icon="pi pi-trash" text rounded size="small" severity="danger"
              v-tooltip="'Excluir'" @click="confirmDelete(label)" />
          </div>
        </div>
      </TransitionGroup>
    </div>

    <!-- delete confirm -->
    <ConfirmDialog group="labels" />
  </Dialog>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Divider from 'primevue/divider'
import Skeleton from 'primevue/skeleton'
import ConfirmDialog from 'primevue/confirmdialog'
import { useConfirm } from 'primevue/useconfirm'
import { useLabelStore, type Label } from '../stores/labels'

defineProps<{ visible: boolean }>()
defineEmits(['update:visible'])

const labelStore = useLabelStore()
const confirm = useConfirm()

const presetColors = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899',
  '#64748b', '#78716c', '#0ea5e9', '#a855f7',
]

const form = reactive({ name: '', color: '#F47A20' })
const editing = ref<Label | null>(null)
const submitting = ref(false)
const formError = ref('')

onMounted(() => labelStore.fetchLabels())

function startEdit(label: Label) {
  editing.value = label
  form.name = label.name
  form.color = label.color
  formError.value = ''
}

function cancelEdit() {
  editing.value = null
  form.name = ''
  form.color = '#F47A20'
  formError.value = ''
}

async function submit() {
  if (!form.name.trim()) { formError.value = 'Nome obrigatório'; return }
  formError.value = ''
  submitting.value = true
  try {
    if (editing.value) {
      await labelStore.updateLabel(editing.value.id, form.name.trim(), form.color)
      cancelEdit()
    } else {
      await labelStore.createLabel(form.name.trim(), form.color)
      form.name = ''
      form.color = '#F47A20'
    }
  } catch (e: any) {
    formError.value = e.response?.data?.error || 'Erro ao salvar'
  } finally {
    submitting.value = false
  }
}

function confirmDelete(label: Label) {
  confirm.require({
    group: 'labels',
    message: `Excluir a etiqueta "${label.name}"? Ela será removida de todas as mensagens.`,
    header: 'Confirmar exclusão',
    icon: 'pi pi-trash',
    acceptClass: 'p-button-danger',
    acceptLabel: 'Excluir',
    rejectLabel: 'Cancelar',
    accept: async () => {
      await labelStore.deleteLabel(label.id)
    }
  })
}
</script>

<style scoped>
.form-section { display: flex; flex-direction: column; gap: .75rem; }
.form-row { display: flex; gap: .75rem; align-items: flex-end; }
.flex-1 { flex: 1; }
.field { display: flex; flex-direction: column; gap: .35rem; }
.field label { font-size: .8rem; font-weight: 500; }
.color-picker-wrap { position: relative; width: 44px; height: 40px; }
.color-input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer; border: none; }
.color-preview { width: 44px; height: 40px; border-radius: 8px; border: 2px solid var(--p-surface-300); pointer-events: none; }
.preset-colors { display: flex; flex-wrap: wrap; gap: .4rem; }
.preset-dot {
  width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent;
  cursor: pointer; transition: transform .1s, border-color .1s;
}
.preset-dot:hover { transform: scale(1.2); }
.preset-dot.active { border-color: var(--p-text-color); transform: scale(1.15); }
.form-actions { display: flex; justify-content: flex-end; gap: .5rem; }
.mt-1 { margin-top: .25rem; }

.labels-list { display: flex; flex-direction: column; gap: .25rem; max-height: 300px; overflow-y: auto; }
.loading-row { display: flex; flex-direction: column; gap: .25rem; }
.empty-labels { display: flex; flex-direction: column; align-items: center; gap: .5rem; padding: 1.5rem; color: var(--p-text-muted-color); font-size: .875rem; }
.label-row {
  display: flex; align-items: center; gap: .6rem;
  padding: .5rem .75rem; border-radius: 8px;
  background: var(--p-surface-50); border: 1px solid var(--p-surface-200);
}
.label-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
.label-name { flex: 1; font-size: .875rem; font-weight: 500; }
.label-count { font-size: .75rem; color: var(--p-text-muted-color); white-space: nowrap; }
.label-actions { display: flex; gap: .1rem; }

/* TransitionGroup */
.label-list-enter-active, .label-list-leave-active { transition: all .2s; }
.label-list-enter-from { opacity: 0; transform: translateY(-8px); }
.label-list-leave-to { opacity: 0; transform: translateX(8px); }
</style>
