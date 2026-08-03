import Redis from 'ioredis'
import { scope } from './logger'

const log = scope('redis')

export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
})

// Sem isso, qualquer instabilidade de conexão com o Redis derruba o processo
// inteiro do backend (EventEmitter lança quando 'error' não tem listener) —
// mesmo mecanismo que derrubou o worker em produção (ver commit c90fb20).
redis.on('error', (err: Error) => log.error({ err: err.message }, 'redis connection error'))
