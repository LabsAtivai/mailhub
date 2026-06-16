<template>
  <div class="auth-page">
    <div class="auth-card">
      <h1>MailHub</h1>
      <p class="subtitle">Criar conta</p>
      <div class="field"><label>Nome</label><InputText v-model="name" fluid /></div>
      <div class="field"><label>E-mail</label><InputText v-model="email" type="email" fluid /></div>
      <div class="field"><label>Senha</label><Password v-model="password" :feedback="false" toggleMask fluid /></div>
      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      <Button label="Criar conta" :loading="loading" @click="submit" fluid />
      <p class="link">Já tem conta? <RouterLink to="/login">Entrar</RouterLink></p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const name = ref(''); const email = ref(''); const password = ref('')
const loading = ref(false); const error = ref('')

async function submit() {
  error.value = ''; loading.value = true
  try { await auth.register(name.value, email.value, password.value); router.push('/') }
  catch (e: any) { error.value = e.response?.data?.error || 'Erro ao criar conta' }
  finally { loading.value = false }
}
</script>

<style scoped>
.auth-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--p-surface-100); }
.auth-card { background: var(--p-surface-0); padding: 2rem; border-radius: 12px; width: 100%; max-width: 400px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
h1 { margin: 0 0 .25rem; font-size: 1.75rem; } .subtitle { color: var(--p-text-muted-color); margin: 0 0 1.5rem; }
.field { display: flex; flex-direction: column; gap: .4rem; margin-bottom: 1rem; }
.field label { font-weight: 500; font-size: .875rem; }
.link { text-align: center; margin-top: 1rem; font-size: .875rem; }
</style>
