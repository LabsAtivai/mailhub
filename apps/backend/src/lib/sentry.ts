import * as Sentry from '@sentry/node'

// Os dois incidentes de produção deste ano só foram diagnosticados porque
// alguém colou log do Portainer manualmente — sem SENTRY_DSN configurada isso
// continua um no-op (Sentry.init nunca roda), então isso não muda nada até
// alguém colar a DSN nas variáveis de ambiente do deploy.
export const sentryEnabled = Boolean(process.env.SENTRY_DSN)

export function initSentry(): void {
  if (!sentryEnabled) return
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.1,
  })
}

export { Sentry }
