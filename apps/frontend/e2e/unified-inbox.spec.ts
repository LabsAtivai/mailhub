import { test, expect, type Page } from '@playwright/test'

// Cobre a Caixa Geral (INBOX de todas as contas numa lista só, estilo "Todas
// as caixas de entrada" do Gmail): mistura mensagens de contas diferentes e
// mostra de qual conta cada uma veio, tudo via mock de rede — sem backend real.

const accounts = [
  {
    id: 'acc1', displayName: 'MKT Roberto', emailAddress: 'roberto@empresa.com',
    incomingHost: 'h', incomingPort: 993, outgoingHost: 'h', outgoingPort: 465,
    username: 'u', tlsMode: 'TLS', syncState: 'IDLE', lastSyncAt: null, lastError: null,
    createdAt: new Date().toISOString(), forwardEnabled: false, forwardTo: null,
  },
  {
    id: 'acc2', displayName: 'MKT Ana', emailAddress: 'ana@empresa.com',
    incomingHost: 'h', incomingPort: 993, outgoingHost: 'h', outgoingPort: 465,
    username: 'u', tlsMode: 'TLS', syncState: 'IDLE', lastSyncAt: null, lastError: null,
    createdAt: new Date().toISOString(), forwardEnabled: false, forwardTo: null,
  },
]

function msg(id: string, accountId: string, subject: string, fromName: string) {
  return {
    id, accountId, uid: id, subject, preview: '', fromName, fromEmail: `${fromName}@cliente.com`,
    toJson: '[]', date: new Date().toISOString(), isRead: false, isFlagged: false, isAnswered: false,
    hasAttachments: false, size: null, inReplyTo: null, labels: [],
  }
}

async function loginWithTwoAccounts(page: Page) {
  await page.route('**/auth/login', route =>
    route.fulfill({ json: { access: 'fake-access', refresh: 'fake-refresh', user: { id: 'u1', name: 'Test User', email: 'user@example.com', role: 'user' } } })
  )
  await page.route('**/auth/me', route =>
    route.fulfill({ json: { id: 'u1', name: 'Test User', email: 'user@example.com', role: 'user' } })
  )
  await page.route('**/labels', route => route.fulfill({ json: [] }))
  await page.route('**/socket.io/**', route => route.abort())
  await page.route('**/accounts', route => route.fulfill({ json: accounts }))
  await page.route('**/accounts/acc1/folders', route =>
    route.fulfill({ json: [{ id: 'f1', path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox', unreadCount: 2, totalMessages: 5 }] })
  )
  await page.route('**/accounts/acc2/folders', route =>
    route.fulfill({ json: [{ id: 'f2', path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox', unreadCount: 1, totalMessages: 3 }] })
  )
  await page.route('**/messages/unified*', route =>
    route.fulfill({ json: { items: [msg('m1', 'acc1', 'Oi do Roberto', 'ClienteA'), msg('m2', 'acc2', 'Oi da Ana', 'ClienteB')], nextCursor: null } })
  )
  // fetchAccounts() seleciona sozinha a INBOX da primeira conta ao montar
  // (comportamento existente, não é da caixa geral) — sem mockar isso aqui,
  // essa chamada vaza pro backend real e derruba a sessão com 401/refresh.
  await page.route('**/folders/f1/messages*', route => route.fulfill({ json: { items: [], nextCursor: null } }))
  await page.route('**/folders/f2/messages*', route => route.fulfill({ json: { items: [], nextCursor: null } }))

  await page.goto('/login')
  await page.locator('.field', { hasText: 'E-mail' }).locator('input').fill('user@example.com')
  await page.locator('.field', { hasText: 'Senha' }).locator('input').fill('senha123')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page).toHaveURL('http://localhost:5173/')
}

test('caixa geral mostra o total de não lidos de todas as contas somado', async ({ page }) => {
  await loginWithTwoAccounts(page)
  await expect(page.locator('li', { hasText: 'Caixa Geral' }).locator('.unread-badge')).toHaveText('3')
})

test('caixa geral mistura mensagens de contas diferentes com o selo de qual conta recebeu', async ({ page }) => {
  await loginWithTwoAccounts(page)
  await page.locator('li', { hasText: 'Caixa Geral' }).click()

  await expect(page.getByText('Oi do Roberto')).toBeVisible()
  await expect(page.getByText('Oi da Ana')).toBeVisible()
  await expect(page.locator('.account-chip', { hasText: 'MKT Roberto' })).toBeVisible()
  await expect(page.locator('.account-chip', { hasText: 'MKT Ana' })).toBeVisible()
})

test('sair da caixa geral pra uma pasta normal não mostra mais o selo de conta', async ({ page }) => {
  await loginWithTwoAccounts(page)
  await page.route('**/folders/f1/messages*', route =>
    route.fulfill({ json: { items: [msg('m1', 'acc1', 'Oi do Roberto', 'ClienteA')], nextCursor: null } })
  )
  await page.locator('li', { hasText: 'Caixa Geral' }).click()
  await expect(page.locator('.account-chip').first()).toBeVisible()

  // contas já vêm expandidas por padrão (onMounted em MailView.vue), então a
  // pasta Inbox de "MKT Roberto" já está visível sem precisar abrir nada.
  await page.locator('li', { hasText: 'Inbox' }).first().click()
  await expect(page.getByText('Oi do Roberto')).toBeVisible()
  await expect(page.locator('.account-chip')).toHaveCount(0)
})
