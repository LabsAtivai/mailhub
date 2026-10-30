# Roadmap: agente de resposta automática em produção

Objetivo: colocar o agente de resposta automática do MailHub para responder, em modo `live`, os e-mails recebidos por 31 clientes da Ativa.ai. Cada cliente tem uma caixa no MailHub e uma base de conhecimento própria, isolada por `accountId`. A aprovação de cada cliente é feita por Jorge.

Clientes: CJP, Apidouro, Avell, Basker Lubrificantes, Blues Filmes, FEAT Viagens, Imperlast, MTSOLUTION, Neoband, Solution Facilities, Terram, Trendx, ULMA, Vinícola Campestre, Solutions USA, SQI, Vt Call, Mplan, Lona das Artes, MWP Log, Winco, J3HC, Visna, Arvis, Caminhos Vida Integral, Tec Nordeste, O conselho, Insuri, Wisedb, Girassol, Dasel. A Hidrofonia está em teste e fica como segundo piloto, fora desta lista.

Estado atual: Avell (`contato@ativa.live`) e Hidrofonia (`hidrofonia@ativa.live`) estão em modo `test`, com respostas enviadas para `labs.ativaai@gmail.com`. A apresentação em PDF da Avell está no banco. O modo `live` só liga se a verificação de prontidão passar (a API devolve 409 caso contrário).

## Fase 0: travas de plataforma

Nada vai a `live` antes disto.

- Guard de frescor: o agente ignora mensagens com mais de cerca de 1 dia e mensagens movidas do Spam para a Inbox. Hoje o `mail:new` pode disparar para e-mail antigo.
- Lista de supressão: um pedido de descadastro grava o remetente por caixa, e o agente nunca mais responde a ele.
- Anti-loop: limite de respostas por remetente por semana, e descarte de auto-respostas e bounces.
- Declarar a tabela `MessageEmbedding` no `schema.prisma`. Ela existe só no banco, e o `prisma db push` do Dockerfile tentará removê-la, como já aconteceu com `ClientKnowledgeChunk` (queda de produção).
- Rotacionar as credenciais expostas na planilha "INFOS DOS CLIENTES 2026" (SendGrid, AWS e outras) e trocar a senha vazada da caixa `hidrofonia@ativa.live`.
- Alertas: taxa de erro, falha de envio e limite diário atingido, avisando Jorge.
- Teste automatizado do fluxo completo: e-mail entra, rascunho é gerado, resposta é enviada, anexo vai junto.

## Fase 0b: infraestrutura de e-mail das caixas dos clientes

O agente só responde o que o worker recebe. O worker mantém uma conexão IMAP IDLE por caixa contra o servidor de e-mail; no HostGator compartilhado isso estourou os limites LVE (erro de inodes no cPanel) quando havia cerca de 1000 caixas. Se o worker precisar ser pausado por causa disso, o agente deixa de responder sem ninguém perceber.

Recomendação: migrar para o Mailcow (já em produção na VPS 62.171.188.84, piloto `mktmailcow.com.br` validado) as caixas dos 31 clientes antes do `live` de cada um. Não precisa migrar as cerca de 1000 de uma vez, pode ser por onda, junto com a Fase 3.

Por cliente, a migração exige:
1. Confirmar onde a caixa está hoje (`incomingHost` na conta do MailHub).
2. Criar o domínio e a caixa no Mailcow (API, ou `mailcow-provision.js`).
3. Ajustar DNS do domínio: MX, SPF, DKIM e DMARC (feito por Jorge no registrador/cPanel).
4. Copiar as mensagens existentes (imapsync) e trocar `incomingHost`/`incomingPort` da conta no MailHub.
5. Validar envio e recebimento reais antes de ligar o agente.

Atenção: a migração de e-mail de cliente mexe em DNS e pode causar perda de recebimento se o MX for trocado sem a cópia concluída. Fazer por cliente, em horário de baixo volume, com rollback do MX.

## Fase 1: piloto live na Avell

- Preencher ou remover os campos "(confirmar)" e "(nome do indicado)" dos documentos, e completar telefone/WhatsApp.
- Remover dos documentos o conteúdo genérico do onboarding da Ativa.ai (cerca de 60% do kickoff).
- Revisar pelo menos 20 rascunhos de teste (tom, CTA, anexo da apresentação) e Jorge aprovar.
- Ligar `live` com limite de 30 por dia por 1 semana, com revisão diária de todas as respostas.
- Critério de saída: nenhuma resposta errada ou fora de política, taxa de erro abaixo de 5%, nenhuma reclamação do cliente.
- Rollback: `mode=off` na caixa, ou `AUTOREPLY_ENABLED=false` no backend.

## Fase 2: onboarding repetível por cliente (1 a 2 dias)

1. Jorge envia a pasta do Drive do cliente. Usamos lista de arquivos permitidos por pasta, nunca busca ampla. Ficam de fora CNPJ, documentos financeiros, bases de leads e qualquer planilha com credenciais.
2. Baixar, transcrever PDFs só de imagem, ingerir, e rodar o escaneamento de placeholders, CNPJ e segredos.
3. Registrar assinatura real, nome do cliente e limite diário na configuração da caixa. Subir o PDF de apresentação quando existir.
4. Modo `test`: no mínimo 5 respostas enviadas e 20 rascunhos revisados.
5. Aprovação de Jorge por escrito: tom, o que nunca dizer, quem assina.
6. Verificação de prontidão sem bloqueios, depois `live` com limite 30, subindo para 50 após a primeira semana limpa.

Automatizar os passos 1 a 3 num script único por cliente.

## Fase 3: ondas

- Onda 1: Avell, Hidrofonia e 2 a 3 clientes com documentação mais completa e maior volume de leads.
- Ondas seguintes: 5 a 8 clientes cada. Só avança se a onda anterior cumprir o critério de saída da Fase 1.
- Clientes que só têm o kickoff genérico no Drive ficam por último, ou pedimos antes o questionário preenchido.
- Cada onda inclui a migração das caixas para o Mailcow (Fase 0b), se ainda não migradas.

## Fase 4: operação contínua

- Visão consolidada dos 31 clientes no painel de Métricas: respostas, interessados, respondidos, erros.
- Revisão semanal por amostragem de 10 respostas por cliente.
- Custo da OpenAI por cliente, com teto mensal.
- Ressincronizar a base quando o cliente atualizar o Drive.
- Um responsável humano por cliente para tratar o que o agente marca como não coberto pela base.

## Decisões em aberto

- Links das pastas do Drive de cada cliente (Jorge enviará).
- Onde cada caixa está hoje (HostGator ou Mailcow), para dimensionar a Fase 0b.
- Hidrofonia: existe PDF de apresentação? Sem ele, o agente usa o link do Vimeo.
- Domínio da Hidrofonia na assinatura (`.com` ou `.com.br`).
