import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import ToastService from 'primevue/toastservice'
import ConfirmationService from 'primevue/confirmationservice'
import Tooltip from 'primevue/tooltip'
import 'primeicons/primeicons.css'
import App from './App.vue'
import router from './router'
import { useAuthStore } from './stores/auth'

// BigInt JSON fix (shared with backend output)
;(BigInt.prototype as any).toJSON = function () { return this.toString() }

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.use(PrimeVue, { theme: { preset: Aura, options: { darkModeSelector: '.dark' } } })
app.use(ToastService)
app.use(ConfirmationService)
app.directive('tooltip', Tooltip)

const auth = useAuthStore()
auth.init().then(() => app.mount('#app'))
