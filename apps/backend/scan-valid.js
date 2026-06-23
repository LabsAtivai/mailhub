const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { ImapFlow } = require('imapflow');

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const rows = parse(fs.readFileSync('logins_mailhub.csv', 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
console.error('Total: ' + rows.length);

const valid = [];
let done = 0;

async function test(row) {
  let client;
  try {
    client = new ImapFlow({
      host: row.imap_host, port: Number(row.imap_port), secure: true,
      auth: { user: row.email, pass: row.password },
      logger: false,
    });
    client.on('error', () => {});

    await Promise.race([
      client.connect(),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 15000)),
    ]);
    valid.push(row);
    console.log('OK ' + row.email);
    await client.logout().catch(() => {});
  } catch {
  } finally {
    if (client) {
      client.removeAllListeners();
      try { client.close(); } catch {}
    }
    done++;
    if (done % 100 === 0) console.error('Progress: ' + done + '/' + rows.length);
  }
}

(async () => {
  for (let i = 0; i < rows.length; i += 10) {
    const batch = rows.slice(i, i + 10);
    await Promise.allSettled(batch.map(test));
  }

  const header = 'email,password,name,imap_host,imap_port,smtp_host,smtp_port';
  const lines = valid.map(r => {
    const pw = r.password.replace(/"/g, '""');
    const nm = (r.name || '').replace(/"/g, '""');
    return r.email + ',"' + pw + '","' + nm + '",' + r.imap_host + ',' + r.imap_port + ',' + r.smtp_host + ',' + r.smtp_port;
  });
  fs.writeFileSync('logins_valid.csv', header + '\n' + lines.join('\n') + '\n');
  console.error('=== RESULTADO ===');
  console.error('Validas: ' + valid.length + ' / ' + rows.length);
  process.exit(0);
})();
