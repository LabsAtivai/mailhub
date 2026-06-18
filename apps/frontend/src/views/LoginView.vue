<template>
  <div class="auth-page">
    <div class="auth-card">
      <div class="brand">
        <h1><span class="brand-ativa">ATIVA</span><span class="brand-ai">.ai</span></h1>
        <span class="brand-product">Mail</span>
      </div>
      <p class="subtitle">Entrar na sua conta</p>

      <div class="field">
        <label>E-mail</label>
        <InputText v-model="email" type="email" placeholder="seu@email.com" fluid />
      </div>
      <div class="field">
        <label>Senha</label>
        <Password v-model="password" :feedback="false" toggleMask fluid />
      </div>
      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      <Button label="Entrar" :loading="loading" @click="submit" fluid />
      <p class="link">Não tem conta? <RouterLink to="/register">Criar conta</RouterLink></p>
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
import { extractError } from '../services/errorMessage'

const auth = useAuthStore()
const router = useRouter()
const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

async function submit() {
  error.value = ''
  loading.value = true
  try {
    await auth.login(email.value, password.value)
    router.push('/')
  } catch (e: unknown) {
    error.value = extractError(e, 'Erro ao entrar')
  } finally { loading.value = false }
}
</script>

<style scoped>
.auth-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #F5F5F5; }
.auth-card { background: #fff; padding: 2.5rem; border-radius: 12px; width: 100%; max-width: 420px; box-shadow: 0 4px 24px rgba(0,0,0,.08); border-top: 3px solid #F47A20; }
.brand { text-align: center; margin-bottom: .25rem; }
.brand h1 { margin: 0; font-size: 2rem; letter-spacing: -.02em; line-height: 1; }
.brand-ativa { color: #111111; font-weight: 700; }
.brand-ai { color: #F47A20; font-weight: 700; }
.brand-product { font-size: .85rem; font-weight: 500; color: #767676; letter-spacing: .1em; text-transform: uppercase; }
.subtitle { color: #767676; margin: .5rem 0 1.5rem; text-align: center; font-size: .9rem; }
.field { display: flex; flex-direction: column; gap: .4rem; margin-bottom: 1rem; }
.field label { font-weight: 500; font-size: .875rem; color: #444444; }
.link { text-align: center; margin-top: 1rem; font-size: .875rem; color: #444444; }
.link a { color: #F47A20; font-weight: 600; text-decoration: none; }
.link a:hover { color: #EA680C; text-decoration: underline; }
</style>
