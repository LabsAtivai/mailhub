// Script manual de teste — NÃO faz parte do fluxo de produção.
// Roda buildReportText() com dados sintéticos (imitando o padrão pedido) e
// dispara sendReportEmail() de verdade, pra inspeção visual no Gmail.
// Uso: npx ts-node scripts/test-report-format.ts

import * as fs from 'fs'
import { buildReportText, AccountReport } from '../src/report/dailyReport'

// api.openai.com não é alcançável a partir deste sandbox de execução local
// (curl confirma falha rápida de conexão) — pulamos a chamada real à IA aqui
// e usamos company/note fixos. summarizeInterestedLead() em si não muda
// nesse teste; validação dela fica pendente de rodar num ambiente com saída
// pra internet (ex: dentro do container do worker em produção).
async function main() {
  const reports: AccountReport[] = [
    {
      displayName: 'ULMA', emailAddress: 'ulma@ativa.ai', syncIssue: null,
      counts: { interessado: 1, encaminhamento: 0, negado: 0, outro: 0 },
      interested: [{ email: 'gabriel@emicol.com.br', name: 'Gabriel Gustavo Stocchi Silvest', subject: 'Re: Automação intralogística ULMA', company: 'Emicol', note: 'respondeu sobre automação intralogística' }],
    },
    {
      displayName: 'Curadoria Pet', emailAddress: 'curadoriapet@ativa.ai', syncIssue: null,
      counts: { interessado: 1, encaminhamento: 0, negado: 0, outro: 0 },
      interested: [{ email: 'vanessa@boutiquedopaodelo.com.br', name: 'Vanessa', subject: 'Re: convite reunião', company: 'Boutique do Pão de Ló', note: 'respondeu ao convite de reunião' }],
    },
    {
      displayName: 'Expresso WGP', emailAddress: 'expressowgp@ativa.ai', syncIssue: null,
      counts: { interessado: 2, encaminhamento: 1, negado: 0, outro: 0 },
      interested: [
        { email: 'moyses@pabovi.com.br', name: 'Moyses', subject: 'Re: convite', company: 'Pabovi Mangueiras', note: 'respondeu ao convite de reunião' },
        { email: 'matheus@poligonal.com.br', name: 'Matheus Gomes', subject: 'Re: convite', company: 'Poligonal Engenharia', note: 'respondeu ao convite de reunião' },
      ],
    },
    {
      displayName: 'Superflow', emailAddress: 'superflow@ativa.ai', syncIssue: null,
      counts: { interessado: 0, encaminhamento: 1, negado: 0, outro: 0 },
      interested: [],
    },
    {
      displayName: 'Hidrolabor', emailAddress: 'hidrolabor@ativa.ai', syncIssue: 'ETIMEDOUT ao conectar IMAP',
      counts: { interessado: 0, encaminhamento: 2, negado: 0, outro: 0 },
      interested: [],
    },
  ]

  const dateKey = new Date().toISOString().slice(0, 10)
  const txt = buildReportText(dateKey, reports)
  fs.writeFileSync(__dirname + '/preview-output.txt', txt, 'utf-8')
}

main().catch(err => { fs.writeFileSync(__dirname + '/preview-output.txt', 'ERROR: ' + String(err), 'utf-8'); process.exit(1) })
