import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
    { path: '/register', component: () => import('../views/RegisterView.vue'), meta: { public: true } },
    { path: '/admin', component: () => import('../views/AdminView.vue'), meta: { adminOnly: true } },
    { path: '/', component: () => import('../views/MailView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ]
})

router.beforeEach((to) => {
  const loggedIn = !!localStorage.getItem('access')
  if (!to.meta.public && !loggedIn) return '/login'
  if (to.meta.public && loggedIn) return '/'
  // main.ts só monta o app depois de auth.init() resolver, então a role já
  // está carregada aqui — a API já bloqueia de qualquer jeito, isso só evita
  // que um usuário comum veja a tela renderizar antes do 403 chegar.
  if (to.meta.adminOnly && !useAuthStore().isAdmin) return '/'
})

export default router
