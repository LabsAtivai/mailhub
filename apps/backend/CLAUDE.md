# CLAUDE.md — MailHub Development Rules

## Project Overview

MailHub é um cliente de e-mail web (estilo Gmail) que substitui webmails tradicionais
(Roundcube, cPanel, Hostinger, Locaweb, Gmail, Outlook) via IMAP/SMTP, com foco na
operação de respostas de cadências de prospecção (Snov.io) — caixa compartilhada,
triagem e etiquetas.

NÃO é: CRM, Help Desk, sistema de tickets, clone de Zendesk.
O objetivo é se comportar como o Gmail.

---

## Estrutura de Repositórios (REALIDADE ATUAL — 3 repos separados)

Diferente de um monorepo, o projeto está em **três repositórios independentes**:

```
mailhub-backend/     API Express + Socket.IO  (porta 3001)
mailhub-worker/      Sync IMAP (IDLE) + jobs
mailhub-frontend/    Vue 3 + PrimeVue         (porta 5173)
```

Decisão consciente para o MVP (deploy independente via Portainer). As consequências:

### Schema Prisma — fonte de verdade única, sincronizada

Como não há `packages/database` compartilhado, o **backend é a fonte de verdade**:

- Editar SEMPRE `mailhub-backend/prisma/schema.prisma`
- O worker sincroniza com `npm run schema:sync` (script lê do backend)
- O `npm run db:generate` do worker roda o sync automaticamente antes do generate
- O arquivo `mailhub-worker/prisma/schema.prisma` tem banner "GERADO AUTOMATICAMENTE" — nunca editar lá

### Tipos compartilhados

Sem `packages/shared`, cada repo mantém seus tipos. Para evitar drift:
- Backend define os DTOs Zod (fonte de verdade de validação)
- Frontend mantém interfaces TS espelhando as respostas da API
- Quando migrar para monorepo (pós-MVP), extrair para `packages/shared`

---

## Architecture Principles

**AP-001** — IMAP é a fonte de verdade. PostgreSQL é só cache/índice/busca.
Mutações vão primeiro ao IMAP (via worker), depois ao banco. ✅ implementado em `messageUseCases`.

**AP-002** — Frontend nunca acessa IMAP. Fluxo: Frontend → API → Redis → Worker → IMAP. ✅

**AP-003** — API e Worker são serviços independentes. Worker: conexões IMAP, sync, jobs.
API: HTTP, auth, WebSocket. ✅

**AP-004** — Máximo 3 conexões IMAP por conta (1 IDLE + 2 ops). ✅ `ImapPool`.

**AP-005** — Redis: filas, pub/sub, rate limiting, cache. ✅

**AP-006** — Paginação por cursor (`date_id`), nunca offset. ✅

**AP-007** — Corpos lazy-loaded. Sync inicial só envelope/flags/bodyStructure/datas. ✅

**AP-008** — Anexos sob demanda; só metadados no sync. ✅

**AP-009** — Eventos socket sempre via API: Worker → Redis → API → Socket.IO → Frontend. ✅

---

## Application Layers (backend)

Lógica de negócio NÃO fica nas rotas. Camadas implementadas:

```
routes.ts      → HTTP, validação Zod, mapeia erros de domínio para status
useCases.ts    → regras de negócio, ownership checks, orquestração
repository.ts  → acesso a dados (Prisma), isolado de HTTP
dto.ts         → schemas Zod compartilhados no módulo
```

Módulos já refatorados: `messages`, `labels`.
Erros de domínio: `NotFoundError`, `ForbiddenError`, `ConflictError` (mapeados para 404/403/409).

> Pendente: `auth` e `accounts` ainda têm lógica nas rotas — migrar quando tocá-los.

---

## Validação

Zod em todos os DTOs. Nunca confiar no payload. Schemas em `<module>/dto.ts`.

## Logging

**Pino** (nunca `console.log`). Logger compartilhado em `src/lib/logger.ts` de cada repo.
Uso: `import { logger, scope } from './lib/logger'` → `scope('sync').info({ accountId }, 'msg')`.

## Security

Senhas de usuário: Argon2id. Credenciais IMAP: AES-256-GCM. HTML: DOMPurify + iframe sandbox.
Proteções: XSS, SSRF (validação de host no cadastro de conta), rate limiting.
Imagens remotas bloqueadas por padrão (anti-tracking).

## Search

PostgreSQL `ILIKE` com índices (sem Elasticsearch no MVP).
Operadores: `from:`, `to:`, `subject:`, `has:attachment`, `is:read`, `is:unread`, `is:flagged`.
> Evolução: migrar para `tsvector` quando o volume justificar.

## Frontend

Vue 3 + Composition API + Pinia + PrimeVue. Sem Options API. Sem Vuex.
Stores: `auth`, `mail`, `labels`. Arrays grandes usam `shallowRef` + updates imutáveis.

## Real Time

Socket.IO. Eventos: `mail:new`, `mail:updated`, `mail:deleted`, `mail:bodyReady`,
`folder:counts`, `account:syncState`. Setup do socket é único (não por conta) para evitar leak de listeners.

## Docker / Deploy

Serviços: frontend, backend, worker, postgres, redis. Rede `ativaai`.
Docker Compose + Portainer. Portas no dev: Postgres 5433, Redis 6380 (evita conflito com locais).

---

## Roadmap de conformidade (pós-MVP)

Itens do plano original ainda não implementados (intencionalmente adiados):
- Monorepo `apps/` + `packages/` (shared, database, logger, ui)
- Migrar `auth` e `accounts` para camada UseCase/Repository
- Testes: Vitest (unit/integration) + Playwright (e2e)
- Observabilidade: Sentry + OpenTelemetry
- CI/CD: GitHub Actions (lint → typecheck → test → build → deploy)
- Busca via PostgreSQL Full Text Search (tsvector)

---

## Forbidden

- Acessar IMAP do frontend
- Editar o schema.prisma do worker manualmente (use schema:sync)
- Lógica de negócio em controllers/rotas
- Paginação por offset
- Polling do inbox (usar IDLE)
- `console.log` (usar Pino)
- `any` desnecessário
- Elasticsearch no MVP
- Comunicação direta Worker → Frontend (sempre via Redis → API)
