/**
 * seed-mailhub.js
 * 
 * Cria os usuários e contas de e-mail do MailHub a partir do CSV gerado.
 * 
 * Uso:
 *   node seed-mailhub.js [--dry-run] [--csv logins_mailhub.csv]
 *
 * Flags:
 *   --dry-run   Mostra o que seria criado sem gravar no banco
 *   --csv       Caminho para o CSV (default: logins_mailhub.csv)
 *
 * Requer:
 *   npm install @prisma/client argon2 csv-parse dotenv
 *   DATABASE_URL no .env (mesmo do backend)
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { parse } = require('csv-parse/sync')
const argon2 = require('argon2')
const crypto = require('crypto')

// ── Prisma ───────────────────────────────────────────────────────────────────
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

// ── AES-256-GCM (mesmo algoritmo do backend) ─────────────────────────────────
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex')

function encrypt(plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const csvPath = (() => {
  const idx = args.indexOf('--csv')
  return idx !== -1 ? args[idx + 1] : path.join(__dirname, 'logins_mailhub.csv')
})()

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 MailHub Seed`)
  console.log(`   CSV: ${csvPath}`)
  console.log(`   Modo: ${DRY_RUN ? '🟡 DRY RUN (nada será gravado)' : '🟢 LIVE'}`)
  console.log()

  if (!fs.existsSync(csvPath)) {
    console.error(`❌ CSV não encontrado: ${csvPath}`)
    process.exit(1)
  }

  const rows = parse(fs.readFileSync(csvPath, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  })

  console.log(`📋 ${rows.length} logins no CSV\n`)

  let created = 0
  let skipped = 0
  let errors = 0
  const errorList = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const { email, password, name, imap_host, imap_port, smtp_host, smtp_port } = row

    if (!email || !password) { skipped++; continue }

    // progress every 50
    if ((i + 1) % 50 === 0 || i === 0) {
      process.stdout.write(`\r  Processando ${i + 1}/${rows.length}...`)
    }

    if (DRY_RUN) {
      console.log(`  [dry] ${email} → user + mail account (${imap_host}:${imap_port})`)
      created++
      continue
    }

    try {
      // Check if user already exists
      const existingUser = await prisma.user.findUnique({ where: { email } })
      if (existingUser) {
        // Check if mail account already linked
        const existingAccount = await prisma.mailAccount.findFirst({
          where: { userId: existingUser.id, emailAddress: email }
        })
        if (existingAccount) { skipped++; continue }

        // User exists but no mail account → just create the account
        await prisma.mailAccount.create({
          data: {
            userId: existingUser.id,
            displayName: name || email.split('@')[0],
            emailAddress: email,
            username: email,
            encryptedPassword: encrypt(password),
            incomingHost: imap_host,
            incomingPort: parseInt(imap_port) || 993,
            outgoingHost: smtp_host,
            outgoingPort: parseInt(smtp_port) || 465,
            tlsMode: 'TLS',
            syncState: 'PENDING',
          }
        })
        created++
        continue
      }

      // Hash password with argon2id
      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
      })

      // Create user + mail account in a transaction
      await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name: name || email.split('@')[0],
            email,
            passwordHash,
          }
        })

        await tx.mailAccount.create({
          data: {
            userId: user.id,
            displayName: name || email.split('@')[0],
            emailAddress: email,
            username: email,
            encryptedPassword: encrypt(password),
            incomingHost: imap_host,
            incomingPort: parseInt(imap_port) || 993,
            outgoingHost: smtp_host,
            outgoingPort: parseInt(smtp_port) || 465,
            tlsMode: 'TLS',
            syncState: 'PENDING',
          }
        })
      })

      created++
    } catch (err) {
      errors++
      errorList.push({ email, error: err.message })
      if (errorList.length <= 5) {
        console.error(`\n  ❌ ${email}: ${err.message}`)
      }
    }
  }

  process.stdout.write('\r')
  console.log(`\n✅ Concluído!`)
  console.log(`   Criados:  ${created}`)
  console.log(`   Pulados:  ${skipped} (já existiam)`)
  console.log(`   Erros:    ${errors}`)

  if (errorList.length > 0) {
    const errFile = path.join(__dirname, 'seed-errors.json')
    fs.writeFileSync(errFile, JSON.stringify(errorList, null, 2))
    console.log(`\n⚠️  Detalhes dos erros: ${errFile}`)
  }

  if (!DRY_RUN) {
    console.log(`\n💡 Próximo passo: iniciar o worker para sincronizar as caixas`)
    console.log(`   O worker vai detectar contas com syncState=PENDING e iniciar o IDLE`)
  }
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())