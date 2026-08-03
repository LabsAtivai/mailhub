import { test, expect, type Page } from '@playwright/test'

// Smoke e2e: sobe só o frontend (Vite dev server) e simula o backend via
// interceptação de rede — não depende de Postgres/Redis/IMAP reais, então
// roda em CI sem infraestrutura extra. Cobre os dois caminhos de maior risco
// desta revisão: o guard de role de /admin e o fluxo de login básico.

async function mockBackend(page: Page, role: 'user' | 'admin') {
  await page.route('**/auth/login', route =>
    route.fulfill({
      json: {
        access: 'fake-access', refresh: 'fake-refresh',
        user: { id: 'u1', name: 'Test User', email: 'user@example.com', role },
      }
    })
  )
  await page.route('**/auth/me', route =>
    route.fulfill({ json: { id: 'u1', name: 'Test User', email: 'user@example.com', role } })
  )
  await page.route('**/accounts', route => route.fulfill({ json: [] }))
  await page.route('**/labels', route => route.fulfill({ json: [] }))
  await page.route('**/socket.io/**', route => route.abort())
}

test('usuario nao autenticado e redirecionado pro login', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.locator('.field', { hasText: 'E-mail' }).locator('input')).toBeVisible()
})

test('login com sucesso leva pra caixa de entrada', async ({ page }) => {
  await mockBackend(page, 'user')
  await page.goto('/login')
  await page.locator('.field', { hasText: 'E-mail' }).locator('input').fill('user@example.com')
  await page.locator('.field', { hasText: 'Senha' }).locator('input').fill('senha123')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page).toHaveURL('http://localhost:5173/')
})

test('usuario comum e bloqueado de acessar /admin (guard de role)', async ({ page }) => {
  await mockBackend(page, 'user')
  await page.addInitScript(() => {
    localStorage.setItem('access', 'fake-access')
    localStorage.setItem('refresh', 'fake-refresh')
  })
  await page.goto('/admin')
  await expect(page).toHaveURL('http://localhost:5173/')
})

test('admin consegue acessar /admin', async ({ page }) => {
  await mockBackend(page, 'admin')
  await page.route('**/admin/stats', route => route.fulfill({ json: { users: 0, accounts: 0, messages: 0, folders: 0, syncingAccounts: 0, errorAccounts: 0 } }))
  await page.route('**/admin/users', route => route.fulfill({ json: [] }))
  await page.route('**/admin/accounts', route => route.fulfill({ json: [] }))
  await page.addInitScript(() => {
    localStorage.setItem('access', 'fake-access')
    localStorage.setItem('refresh', 'fake-refresh')
  })
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByText('Painel Admin')).toBeVisible()
})
