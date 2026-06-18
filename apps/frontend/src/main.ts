import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import { definePreset } from '@primevue/themes'
import Aura from '@primevue/themes/aura'
import ToastService from 'primevue/toastservice'
import ConfirmationService from 'primevue/confirmationservice'
import Tooltip from 'primevue/tooltip'
import 'primeicons/primeicons.css'
import App from './App.vue'
import router from './router'
import { useAuthStore } from './stores/auth'

// BigInt JSON fix — backend serializes BigInt as string, but keep support for client-side serialization
const origStringify = JSON.stringify
JSON.stringify = function (value: unknown, replacer?: unknown, space?: unknown) {
  const bigintReplacer = (_k: string, v: unknown) => typeof v === 'bigint' ? v.toString() : v
  const effectiveReplacer = typeof replacer === 'function'
    ? (_k: string, v: unknown) => bigintReplacer(_k, (replacer as (k: string, v: unknown) => unknown)(_k, v))
    : bigintReplacer
  return origStringify(value, effectiveReplacer, space as number | string | undefined)
} as typeof JSON.stringify

const AtivaPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#FFF7ED',
      100: '#FFEDD5',
      200: '#FED7AA',
      300: '#FDBA74',
      400: '#FB923C',
      500: '#F47A20',
      600: '#EA680C',
      700: '#C2570C',
      800: '#9A3412',
      900: '#7C2D12',
      950: '#431407',
    },
    colorScheme: {
      light: {
        primary: {
          color: '#F47A20',
          inverseColor: '#ffffff',
          hoverColor: '#EA680C',
          activeColor: '#C2570C',
        },
        surface: {
          0: '#ffffff',
          50: '#F9FAFB',
          100: '#F5F5F5',
          200: '#E5E5E5',
          300: '#D4D4D4',
          400: '#A3A3A3',
          500: '#767676',
          600: '#525252',
          700: '#444444',
          800: '#262626',
          900: '#171717',
          950: '#111111',
        },
      },
    },
  },
})

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.use(PrimeVue, { theme: { preset: AtivaPreset, options: { darkModeSelector: '.dark' } } })
app.use(ToastService)
app.use(ConfirmationService)
app.directive('tooltip', Tooltip)

const auth = useAuthStore()
auth.init().then(() => app.mount('#app'))
