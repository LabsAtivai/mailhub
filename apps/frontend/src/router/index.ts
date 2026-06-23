import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
    { path: '/register', component: () => import('../views/RegisterView.vue'), meta: { public: true } },
    { path: '/admin', component: () => import('../views/AdminView.vue') },
    { path: '/', component: () => import('../views/MailView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ]
})

router.beforeEach((to) => {
  const loggedIn = !!localStorage.getItem('access')
  if (!to.meta.public && !loggedIn) return '/login'
  if (to.meta.public && loggedIn) return '/'
})

export default router
