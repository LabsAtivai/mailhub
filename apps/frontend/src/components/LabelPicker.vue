<template>
  <div class="label-picker" ref="rootRef">
    <!-- trigger -->
    <Button icon="pi pi-tag" :label="triggerLabel" text size="small"
      @click="toggle" v-tooltip="'Etiquetas'" />

    <!-- dropdown -->
    <Teleport to="body">
      <div v-if="open" class="picker-dropdown" :style="dropdownStyle" ref="dropRef">
        <div class="picker-search">
          <InputText v-model="search" placeholder="Buscar etiqueta..." fluid autofocus size="small" />
        </div>

        <div class="picker-list">
          <div v-if="filtered.length === 0" class="picker-empty">
            Nenhuma etiqueta encontrada
          </div>
          <div v-for="label in filtered" :key="label.id"
            class="picker-item"
            :class="{ assigned: isAssigned(label.id) }"
            @click="toggle_(label)">
            <div class="picker-dot" :style="{ background: label.color }"></div>
            <span class="picker-name">{{ label.name }}</span>
            <i v-if="isAssigned(label.id)" class="pi pi-check picker-check"></i>
          </div>
        </div>

        <div class="picker-footer">
          <Button label="Gerenciar etiquetas" text size="small" icon="pi pi-cog"
            @click="$emit('manage'); open = false" />
        </div>
      </div>
    </Teleport>

    <!-- assigned label chips (shown below message header) -->
    <div v-if="assigned.length > 0" class="assigned-chips">
      <span v-for="label in assigned" :key="label.id"
        class="label-chip"
        :style="{ background: label.color + '22', borderColor: label.color, color: label.color }">
        {{ label.name }}
        <i class="pi pi-times chip-remove" @click.stop="toggle_(label)"></i>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import { useLabelStore, type Label } from '../stores/labels'

const props = defineProps<{
  messageId: string
  initialLabels: Label[]
}>()
const emit = defineEmits(['manage', 'change'])

const labelStore = useLabelStore()

const open = ref(false)
const search = ref('')
const assigned = ref<Label[]>([...props.initialLabels])
const rootRef = ref<HTMLElement | null>(null)
const dropRef = ref<HTMLElement | null>(null)
const dropdownStyle = ref({})

const triggerLabel = computed(() => assigned.value.length > 0 ? String(assigned.value.length) : '')

const filtered = computed(() =>
  labelStore.labels.filter(l =>
    l.name.toLowerCase().includes(search.value.toLowerCase())
  )
)

function isAssigned(labelId: string) {
  return assigned.value.some(l => l.id === labelId)
}

async function toggle_(label: Label) {
  const wasAssigned = isAssigned(label.id)
  const prev = [...assigned.value]
  // optimistic update
  assigned.value = wasAssigned
    ? assigned.value.filter(l => l.id !== label.id)
    : [...assigned.value, label]
  try {
    if (wasAssigned) {
      await labelStore.removeLabel(props.messageId, label.id)
    } else {
      await labelStore.assignLabel(props.messageId, label.id)
    }
    emit('change', assigned.value)
  } catch {
    assigned.value = prev
  }
}

function toggle() {
  open.value = !open.value
  if (open.value) {
    search.value = ''
    positionDropdown()
  }
}

function positionDropdown() {
  if (!rootRef.value) return
  const rect = rootRef.value.getBoundingClientRect()
  const dropH = 320
  const dropW = 220
  const spaceBelow = window.innerHeight - rect.bottom - 8
  const top = spaceBelow >= dropH ? rect.bottom + 4 : rect.top - dropH - 4
  const left = Math.min(rect.left, window.innerWidth - dropW - 8)
  dropdownStyle.value = {
    position: 'fixed',
    top: Math.max(4, top) + 'px',
    left: Math.max(4, left) + 'px',
    zIndex: 9999,
    width: dropW + 'px',
  }
}

function onClickOutside(e: MouseEvent) {
  const target = e.target as Node
  if (rootRef.value?.contains(target)) return
  if (dropRef.value?.contains(target)) return
  open.value = false
}

watch(() => props.initialLabels, (v) => { assigned.value = [...v] }, { deep: true })

onMounted(() => document.addEventListener('mousedown', onClickOutside))
onBeforeUnmount(() => document.removeEventListener('mousedown', onClickOutside))
</script>

<style scoped>
.label-picker { display: inline-flex; flex-direction: column; gap: .35rem; }

/* dropdown */
.picker-dropdown {
  background: var(--p-surface-0);
  border: 1px solid var(--p-surface-300);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,.12);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: 320px;
}
.picker-search { padding: .5rem; border-bottom: 1px solid var(--p-surface-200); }
.picker-list { flex: 1; overflow-y: auto; padding: .25rem 0; }
.picker-empty { padding: .75rem 1rem; font-size: .8rem; color: var(--p-text-muted-color); text-align: center; }
.picker-item {
  display: flex; align-items: center; gap: .5rem;
  padding: .45rem .75rem; cursor: pointer; transition: background .1s;
}
.picker-item:hover { background: var(--p-surface-100); }
.picker-item.assigned { background: var(--p-surface-50); }
.picker-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.picker-name { flex: 1; font-size: .85rem; }
.picker-check { font-size: .75rem; color: var(--p-primary-color); }
.picker-footer { border-top: 1px solid var(--p-surface-200); padding: .25rem .5rem; }

/* chips */
.assigned-chips { display: flex; flex-wrap: wrap; gap: .3rem; }
.label-chip {
  display: inline-flex; align-items: center; gap: .3rem;
  padding: .15rem .5rem; border-radius: 20px; border: 1px solid;
  font-size: .75rem; font-weight: 500; white-space: nowrap;
}
.chip-remove { font-size: .65rem; cursor: pointer; opacity: .7; }
.chip-remove:hover { opacity: 1; }
</style>
