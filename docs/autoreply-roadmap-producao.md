# Roadmap: agente de resposta automática em produção

Objetivo: colocar o agente de resposta automática do MailHub para responder, em modo `live`, os e-mails recebidos por 31 clientes da Ativa.ai. A aprovação de cada cliente é feita por Jorge.

Revisado em 2026-11-05. Principais mudanças em relação à versão anterior:
- Modelo de dados: um cliente tem N caixas e um único conteúdo (ver "Modelo: 1 cliente, N caixas").
- As pastas do Drive dos 31 clientes já estão mapeadas em `respondedor/clientes_drive.json`.
- A migração para o Mailcow passa a ser pré-requisito explícito do `live` de cada cliente, e o lote é por cliente.

Clientes: CJP, Apidouro, Avell, Basker Lubrificantes, Blues Filmes, FEAT Viagens, Imperlast, MTSOLUTION, Neoband, Solution Facilities, Terram, Trendx, ULMA, Vinícola Campestre, Solutions USA, SQI, Vt Call, Mplan, Lona das Artes, MWP Log, Winco, J3HC, Visna, Arvis, Caminhos Vida Integral, Tec Nordeste, O conselho, Insuri, Wisedb, Girassol, Dasel. A Hidrofonia está em teste e fica como segundo piloto, fora desta lista.

## Modelo: 1 cliente, N caixas, 1 conteúdo

Cada cliente tem um domínio (em geral `mkt<nome>.com.br`) e várias caixas, que são variantes do mesmo remetente (ex.: `claudio@`, `claudio_@`, `claudio-@`). Todas usam o mesmo conteúdo.

Implementação (feita, ainda não commitada nem deployada):
- `AutoReplyConfig.knowledgeAccountId` (nullable). Uma caixa por cliente é a "dona" do conteúdo: guarda a base de conhecimento (`ClientKnowledgeChunk`) e os anexos (`ClientAsset`). As demais caixas do cliente apontam para ela.
- Sem o campo, a caixa usa o próprio conteúdo. Avell e Hidrofonia continuam funcionando sem mudança.
- O `PUT /admin/auto-reply/:accountId` rejeita apontar para si mesma, para caixa sem configuração e encadeamento (a dona não pode apontar para outra).
- Continua por caixa: modo (`off`/`shadow`/`test`/`live`), limite diário, anti-loop (1 resposta por thread/24h), assinatura e logs. Cada caixa liga e desliga sozinha.
- A verificação de prontidão lê o conteúdo da caixa dona.
- Deploy: a coluna é nullable e entra pelo `prisma db push` do boot. Rodar `npm run schema:sync` no worker se ele usar o model.

Pontos a definir:
- Limite diário: por caixa (como hoje) ou somado por cliente. Com N caixas por cliente, o teto por caixa multiplica o volume total. Sugestão: manter por caixa e acrescentar um teto por cliente na Fase 4.
- Assinatura: hoje é por caixa. Se as caixas de um cliente assinam como a mesma pessoa, copiar da dona no provisionamento.

## Estado atual

- Avell (`contato@ativa.live`) e Hidrofonia (`hidrofonia@ativa.live`) estão em modo `test`, com respostas enviadas para `labs.ativaai@gmail.com`. A apresentação em PDF da Avell está no banco.
- O modo `live` só liga se a verificação de prontidão passar (a API devolve 409 caso contrário).
- Os docs da Avell e da Hidrofonia estão baixados em `respondedor/clientes/`. Os outros 29 clientes têm a pasta do Drive mapeada, mas nada baixado.
- Mailcow em produção na VPS 62.171.188.84. Piloto `mktmailcow.com.br` validado ponta a ponta (MX, SPF, DKIM, DMARC, envio e recebimento). `mailcow-provision.js` pronto (dry-run por padrão, `--apply` para executar).
- As caixas dos clientes continuam no HostGator até serem migradas.

## Fase 0: travas de plataforma

Nada vai a `live` antes disto. O estado de cada item precisa ser reconferido no código antes de marcar como feito.

- Guard de frescor: o agente ignora mensagens com mais de cerca de 1 dia e mensagens movidas do Spam para a Inbox. Hoje o `mail:new` pode disparar para e-mail antigo.
- Lista de supressão: um pedido de descadastro grava o remetente por caixa, e o agente nunca mais responde a ele. Com N caixas por cliente, a supressão deve valer para o cliente inteiro: quem pediu remoção de uma caixa não pode receber resposta de outra caixa do mesmo cliente.
- Anti-loop: limite de respostas por remetente por semana, e descarte de auto-respostas e bounces.
- Declarar a tabela `MessageEmbedding` no `schema.prisma`. Ela existe só no banco, e o `prisma db push` do Dockerfile tentará removê-la, como já aconteceu com `ClientKnowledgeChunk` (queda de produção).
- Rotacionar as credenciais expostas na planilha "INFOS DOS CLIENTES 2026" (SendGrid, AWS e outras) e trocar a senha vazada da caixa `hidrofonia@ativa.live`.
- Alertas: taxa de erro, falha de envio e limite diário atingido, avisando Jorge.
- Teste automatizado do fluxo completo: e-mail entra, rascunho é gerado, resposta é enviada, anexo vai junto. Incluir um caso com caixa filha usando o conteúdo da dona.
- Redeploy do backend e do frontend no Portainer. O webhook do CI roda com `continue-on-error` e falha em silêncio, então confirmar que os containers foram recriados com a imagem nova.
- Variável `AUTOREPLY_ENABLED=true` no backend (kill switch global).

## Fase 0b: infraestrutura de e-mail dos clientes (migração para o Mailcow)

O agente só responde o que o worker recebe. O worker mantém uma conexão IMAP IDLE por caixa contra o servidor de e-mail; no HostGator compartilhado isso estourou os limites LVE (erro de inodes no cPanel) quando havia cerca de 1000 caixas. Se o worker precisar ser pausado por causa disso, o agente deixa de responder sem ninguém perceber.

Regra: migrar para o Mailcow antes do `live` de cada cliente. O lote de migração é o cliente (domínio inteiro, com todas as caixas), nunca caixa avulsa, porque o MX é por domínio.

Por cliente:
1. Listar as caixas do domínio e confirmar o `incomingHost` atual de cada uma no MailHub.
2. `mailcow-provision.js` em dry-run para o domínio, conferir, depois `--apply` (cria domínio e todas as caixas).
3. Gerar o DKIM no admin do Mailcow e publicar o DNS do domínio: MX, SPF, DKIM e DMARC, mais CNAME de `autodiscover`/`autoconfig`. Feito por Jorge no registrador/cPanel. Lembrar de apagar registro A conflitante antes de criar CNAME, e conferir com `nslookup ... 8.8.8.8`.
4. Copiar as mensagens existentes (imapsync) de cada caixa.
5. Trocar `incomingHost`/`incomingPort` das contas no MailHub (993/465, `mail.labsativa.com.br`).
6. Validar envio e recebimento reais em pelo menos uma caixa do domínio antes de ligar o agente.

Cuidados:
- Trocar o MX antes de a cópia terminar causa perda de recebimento. Fazer em horário de baixo volume, com rollback do MX preparado.
- O IP da produção do MailHub (207.244.249.157) precisa estar no `API_ALLOW_FROM` do Mailcow.
- "Authentication failed" logo após o cadastro pode ser ban temporário do fail2ban do Mailcow (`netfilter-mailcow`), não senha errada. Checar com `fail2ban-client status <jail>` antes de suspeitar de configuração.
- Senhas das caixas vêm da planilha de clientes e são recriptografadas com a `ENCRYPTION_KEY` de produção. Em qualquer dessincronia, a fonte de verdade é o `docker inspect` do container em execução.
- Este ambiente não tem acesso ao DNS, ao cPanel/WHM nem ao painel da Contabo. Essas ações são do Jorge, com scripts e instruções preparados aqui. O SSH na VPS do Mailcow é possível por chave.

## Fase 1: piloto live na Avell

- Preencher ou remover os campos "(confirmar)" e "(nome do indicado)" dos documentos, e completar telefone/WhatsApp.
- Remover dos documentos o conteúdo genérico do onboarding da Ativa.ai (cerca de 60% do kickoff).
- Revisar pelo menos 20 rascunhos de teste (tom, CTA, anexo da apresentação) e Jorge aprovar.
- Migrar o domínio da Avell para o Mailcow (Fase 0b) e validar.
- Ligar `live` com limite de 30 por dia por 1 semana, com revisão diária de todas as respostas. Começar por uma caixa e abrir as demais do cliente só depois de 2 dias limpos.
- Critério de saída: nenhuma resposta errada ou fora de política, taxa de erro abaixo de 5%, nenhuma reclamação do cliente.
- Rollback: `mode=off` na caixa, ou `AUTOREPLY_ENABLED=false` no backend.

## Fase 2: onboarding repetível por cliente (1 a 2 dias)

Automatizar os passos 1 a 4 num script único por cliente (`respondedor/scripts/provision_client.py`, a criar). Ele usa `clientes_drive.json` (pasta do Drive), a planilha de clientes (domínio e caixas) e a API admin do MailHub.

1. Download da pasta do Drive do cliente. Usar lista de arquivos permitidos por pasta, nunca busca ampla. Ficam de fora CNPJ, documentos financeiros, bases de leads, apresentações de resultados e qualquer planilha com credenciais. Os candidatos já estão pré-filtrados em `clientes_drive.json`.
2. Transcrever PDFs só de imagem (OCR), ingerir na caixa dona, e rodar o escaneamento de placeholders, CNPJ e segredos.
3. Escolher a caixa dona, configurá-la (assinatura real, nome do cliente, limite diário) e apontar as demais caixas do domínio para ela com `knowledgeAccountId`. Subir o PDF de apresentação na dona, quando existir.
4. Montar o `manifest.json` do cliente (slug, domínios, caixa dona, caixas filhas, assinatura, `drive_folder_id`).
5. Modo `test`: no mínimo 5 respostas enviadas e 20 rascunhos revisados, contando todas as caixas do cliente.
6. Aprovação de Jorge por escrito: tom, o que nunca dizer, quem assina.
7. Verificação de prontidão sem bloqueios, depois `live` com limite 30, subindo para 50 após a primeira semana limpa.

## Fase 3: ondas

- Onda 1: Avell, Hidrofonia e 2 a 3 clientes com documentação mais completa e maior volume de leads. Candidatos pelo volume de arquivos no Drive: Girassol, Dasel, Blues Filmes, Trendx. Confirmar pelo volume real de e-mails recebidos.
- Ondas seguintes: 5 a 8 clientes cada. Só avança se a onda anterior cumprir o critério de saída da Fase 1.
- Clientes que só têm o kickoff genérico no Drive ficam por último, ou pedimos antes o questionário preenchido.
- Cada onda inclui a migração dos domínios para o Mailcow (Fase 0b), se ainda não migrados.
- Dentro de um cliente: ligar `live` primeiro na caixa dona, depois nas demais.

## Fase 4: operação contínua

- Visão consolidada dos 31 clientes no painel de Métricas, agregando as caixas de cada cliente: respostas, interessados, respondidos, erros.
- Teto diário por cliente, somando as caixas.
- Revisão semanal por amostragem de 10 respostas por cliente.
- Custo da OpenAI por cliente, com teto mensal.
- Ressincronizar a base quando o cliente atualizar o Drive. A ressincronização roda uma vez na caixa dona e vale para todas.
- Um responsável humano por cliente para tratar o que o agente marca como não coberto pela base.
- Backup do Mailcow: hoje só local na VPS (cron 03:00, 7 dias). Reavaliar backup externo quando houver mais clientes em produção.

## Decisões fechadas

- Um cliente tem N caixas e um único conteúdo (decisão de 2026-11-05).
- A migração para o Mailcow é por cliente (domínio inteiro) e vem antes do `live`.
- Links das pastas do Drive: mapeados em `respondedor/clientes_drive.json` para os 31 clientes.

## Decisões em aberto

- Limite diário por caixa ou por cliente (ver "Modelo").
- Supressão de descadastro por cliente (recomendado) ou por caixa.
- Hidrofonia: existe PDF de apresentação? Sem ele, o agente usa o link do Vimeo.
- Domínio da Hidrofonia na assinatura (`.com` ou `.com.br`).
- Nomes de domínio fora do padrão `mkt<nome>` (FEAT: `featbusiness.com.br`, Neoband: `grupoexpobandmkt.com.br`, Solution Facilities: `.com`) e os 19 clientes cujo cruzamento com a planilha ainda não foi conferido.
- Quais caixas de cada cliente entram no agente: todas as variantes ou só as que recebem resposta de verdade.
