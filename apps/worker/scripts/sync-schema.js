// Sincroniza o schema.prisma a partir do backend (fonte de verdade).
// Em 3 repos separados não há packages/database compartilhado, então
// este script mantém o worker alinhado sem cópia manual.
// Uso: node scripts/sync-schema.js [caminho-do-backend]

const fs = require('fs')
const path = require('path')

const backendPath = process.argv[2] || path.resolve(__dirname, '../../mailhub-backend')
const src = path.join(backendPath, 'prisma', 'schema.prisma')
const dest = path.join(__dirname, '..', 'prisma', 'schema.prisma')

if (!fs.existsSync(src)) {
  console.error(`Schema do backend nao encontrado em: ${src}`)
  console.error('Passe o caminho do backend: node scripts/sync-schema.js ../mailhub-backend')
  process.exit(1)
}

const content = fs.readFileSync(src, 'utf8')
const banner = '// GERADO AUTOMATICAMENTE - fonte de verdade: mailhub-backend/prisma/schema.prisma\n' +
               '// Nao edite aqui. Rode: npm run schema:sync\n\n'

fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, banner + content)
console.log('OK: schema.prisma sincronizado do backend')
