import axios from 'axios'
import { refreshSocketToken } from './socket'

export const api = axios.create({ baseURL: '/', timeout: 30000 })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('access')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

let refreshPromise: Promise<void> | null = null

async function doRefresh() {
  const refresh = localStorage.getItem('refresh')
  if (!refresh) throw new Error('no refresh token')
  const { data } = await axios.post('/auth/refresh', { refresh })
  localStorage.setItem('access', data.access)
  localStorage.setItem('refresh', data.refresh)
  refreshSocketToken()
}

api.interceptors.response.use(
  (r) => r,
  async (error) => {
    const original = error.config
    const isAuthEndpoint = original.url?.startsWith('/auth/')
    if (error.response?.status === 401 && !original._retry && !isAuthEndpoint) {
      original._retry = true
      try {
        if (!refreshPromise) {
          refreshPromise = doRefresh().finally(() => { refreshPromise = null })
        }
        await refreshPromise
        original.headers.Authorization = `Bearer ${localStorage.getItem('access')}`
        return api(original)
      } catch {
        localStorage.removeItem('access')
        localStorage.removeItem('refresh')
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)
