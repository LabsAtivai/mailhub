// Sincroniza o schema.prisma a partir do backend (fonte de verdade).
// Funciona tanto no layout monorepo (apps/backend) quanto no de 3 repos separados.
// Uso: node scripts/sync-schema.js [caminho-do-backend]

const fs = require('fs')
const path = require('path')

const candidates = [
  process.argv[2],
  path.resolve(__dirname, '../../backend'),
  path.resolve(__dirname, '../../mailhub-backend'),
]

const backendPath = candidates.find(p => p && fs.existsSync(path.join(p, 'prisma', 'schema.prisma')))
if (!backendPath) {
  console.error('Schema do backend nao encontrado. Tentei:')
  candidates.filter(Boolean).forEach(p => console.error(`  - ${path.join(p, 'prisma', 'schema.prisma')}`))
  console.error('Passe o caminho: node scripts/sync-schema.js ../backend')
  process.exit(1)
}

const src = path.join(backendPath, 'prisma', 'schema.prisma')
const dest = path.join(__dirname, '..', 'prisma', 'schema.prisma')

const content = fs.readFileSync(src, 'utf8')
const banner = '// GERADO AUTOMATICAMENTE - fonte de verdade: mailhub-backend/prisma/schema.prisma\n' +
               '// Nao edite aqui. Rode: npm run schema:sync\n\n'

fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, banner + content)
console.log(`OK: schema.prisma sincronizado de ${src}`)
