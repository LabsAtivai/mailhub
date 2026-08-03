import * as Sentry from '@sentry/node'

// Sem SENTRY_DSN configurada isso continua um no-op (Sentry.init nunca roda)
// — só passa a reportar de verdade quando alguém colar a DSN no deploy.
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
