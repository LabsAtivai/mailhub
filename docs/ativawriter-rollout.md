# Plano de rollout — AtivaWriter em todas as caixas

Status: rascunho inicial (nenhum planejamento existia antes deste documento).
Criado em: 2026-09-08.

## O que já existe hoje (estado atual)

- **AtivaWriter** é o system prompt do gerador de resposta por IA
  (`apps/backend/src/modules/ai/openaiClient.ts::generateReplyText`).
- O botão "Gerar resposta com IA" já aparece em **todas as contas**, sem
  feature flag — está sempre visível no reply do `ComposeDialog.vue`
  (frontend), chamando `POST /messages/:id/ai-reply`.
- A qualidade da resposta depende de duas fontes de contexto, ambas
  incompletas hoje:
  1. **RAG sobre a pasta Sent** (até 5 respostas anteriores similares,
     via embeddings). Só é populado automaticamente **daqui pra frente**
     (hook `indexMessageIfSent`, disparado quando um corpo termina de
     carregar). O histórico antigo de cada conta só é indexado se alguém
     rodar manualmente `POST /accounts/:id/ai-index` (indexa a conta
     inteira) ou `POST /accounts/:id/clients/:id/backfill` (indexa só o
     histórico endereçado a um domínio de cliente específico).
  2. **Perfil de cliente** (`ClientProfile`): texto de contexto escrito à
     mão por domínio, por conta, via `ClientProfilesDialog.vue`. É
     puramente manual — não escala pra muitas contas/domínios sozinho.
- O comentário no próprio código confirma que hoje é modo piloto: rodar
  o backfill escopado a um cliente configurado "antes de rodar em cima
  da caixa inteira" (`routes.ts`, rota de backfill).
- Não existe: controle de custo/rate limit de uso de OpenAI por conta,
  toggle de habilitar/desabilitar por conta, e dashboard de
  acompanhamento de uso/erros (só há log estruturado via Pino, escopo
  `ai`).

## Restrição importante do ambiente

O worker já opera perto do limite do host compartilhado HostGator/cPanel
(ver [[project_worker_cpanel_inodes]] na memória — ~1000 conexões IMAP
IDLE simultâneas estourando limites de LVE) e está em processo de
[[project_mailcow_migration]]. Qualquer backfill em massa (indexação de
Sent de todas as contas) **não pode gerar novas conexões IMAP em
paralelo sem controle** — precisa rodar throttled, fora do horário de
pico, e idealmente depois (ou em paralelo controlado com) a migração
pro Mailcow, pra não competir por recursos com a estabilização do sync.

## Fases propostas

### Fase 1 — Backfill de corpo + indexação em massa
- Hoje, buscar corpo de mensagens antigas da pasta Sent só existe de
  forma automática (fetch on-demand) ou escopada a um domínio de
  cliente (`backfillClientDomain`, que já enfileira `mailhub:fetch:body`
  pros que não têm corpo). Falta um caso de uso equivalente **sem** o
  escopo de domínio: varrer Sent inteira de cada conta, enfileirar busca
  de corpo pro que falta, e indexar o resto.
- Rodar em lote por conta, com limite de contas/mensagens por ciclo
  (reaproveitar o padrão de scheduler do worker, `setInterval` +
  checagem de horário, já usado pro relatório diário e purga de lixeira).
- Rodar fora do horário comercial, throttled, monitorando erro de rate
  limit da OpenAI e falhas de IMAP.

### Fase 2 — Controle de custo e limite
- Adicionar teto diário/mensal de chamadas de embedding e de geração de
  resposta (por conta e/ou global), com circuit breaker (mesmo padrão
  de lock via Redis já usado no relatório diário).
- Acompanhar custo real da OpenAI durante o piloto atual antes de abrir
  pra todas as contas, pra dimensionar o teto.

### Fase 3 — Habilitação gradual
- Já que o botão está sempre visível, "habilitar em todas as caixas" na
  prática significa: garantir que a Fase 1 (backfill) rodou pra conta
  antes de expor com confiança, e monitorar qualidade/erros por lote.
- Rollout em ondas (ex: 10% das contas → 50% → 100%), acompanhando logs
  do escopo `ai` e feedback de quem usa, antes de avançar pra próxima
  onda.
- Considerar um campo de habilitação por conta (hoje não existe) se o
  rollout gradual precisar de um kill switch por conta em vez de
  global.

### Fase 4 — Perfis de cliente (contexto adicional)
- `ClientProfile` continua manual e opcional — a resposta funciona sem
  ele (só usa o RAG de Sent). Decidir se isso fica como enriquecimento
  opt-in por conta/cliente, ou se entra num backlog separado de
  importação em massa. Não é bloqueador pro rollout geral.

### Fase 5 — Observabilidade e fechamento
- Dashboard ou relatório simples de uso (respostas geradas, taxa de
  erro, custo) antes de declarar rollout completo.
- Documentar aqui o resultado de cada onda.

## Em aberto (decisões do usuário)

- Teto de custo aceitável por mês antes de abrir pra todas as contas.
- Se o rollout deve esperar a migração pro Mailcow terminar, ou pode
  correr em paralelo com throttling.
- Se falta segmentar por conta (habilitar/desabilitar individualmente)
  ou se rollout é tudo-ou-nada por onda.
