// Calendário brasileiro + horário de Brasília (America/Sao_Paulo), padrão do sistema.
export const BRASILIA_TZ = 'America/Sao_Paulo'

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']

// Feriados nacionais fixos (MM-DD).
const FIXED_HOLIDAYS: Record<string, string> = {
  '01-01': 'Confraternização Universal',
  '04-21': 'Tiradentes',
  '05-01': 'Dia do Trabalho',
  '09-07': 'Independência do Brasil',
  '10-12': 'Nossa Senhora Aparecida',
  '11-02': 'Finados',
  '11-15': 'Proclamação da República',
  '11-20': 'Consciência Negra',
  '12-25': 'Natal',
}

export interface BrasiliaNow {
  year: number; month: number; day: number
  hour: number; minute: number; weekday: number
}

export function brasiliaNow(date = new Date()): BrasiliaNow {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: BRASILIA_TZ, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', weekday: 'short',
    }).formatToParts(date).map(p => [p.type, p.value]),
  )
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +parts.hour, minute: +parts.minute, weekday,
  }
}

// Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher).
function easter(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month - 1, day))
}

const key = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000)

// Mapa 'YYYY-MM-DD' -> nome, com fixos e móveis (Carnaval, Sexta-feira Santa, Corpus Christi).
export function holidaysOf(year: number): Map<string, string> {
  const map = new Map<string, string>()
  for (const [md, name] of Object.entries(FIXED_HOLIDAYS)) map.set(`${year}-${md}`, name)
  const pascoa = easter(year)
  map.set(key(addDays(pascoa, -48)), 'Segunda-feira de Carnaval')
  map.set(key(addDays(pascoa, -47)), 'Terça-feira de Carnaval')
  map.set(key(addDays(pascoa, -2)), 'Sexta-feira Santa')
  map.set(key(addDays(pascoa, 60)), 'Corpus Christi')
  return map
}

// Bloco de contexto temporal pra injetar no prompt: data/hora atual em Brasília
// e os próximos dias úteis já filtrados (sem fim de semana nem feriado).
export function brasiliaPromptContext(now = new Date(), businessDays = 7): string {
  const n = brasiliaNow(now)
  const today = new Date(Date.UTC(n.year, n.month - 1, n.day))
  const holidays = new Map([...holidaysOf(n.year), ...holidaysOf(n.year + 1)])
  const fmt = (d: Date) => {
    const wd = WEEKDAYS[d.getUTCDay()]
    return `${wd}, ${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`
  }

  const todayHoliday = holidays.get(key(today))
  const lines = [
    `Agora: ${fmt(today)}, ${String(n.hour).padStart(2, '0')}h${String(n.minute).padStart(2, '0')} (horário de Brasília).`,
  ]
  if (todayHoliday) lines.push(`Hoje é feriado nacional: ${todayHoliday}.`)

  const days: string[] = []
  for (let i = 1; days.length < businessDays && i < 30; i++) {
    const d = addDays(today, i)
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6 || holidays.has(key(d))) continue
    days.push(fmt(d))
  }
  lines.push('Próximos dias úteis válidos para sugerir horários (nunca use outras datas):')
  lines.push(...days.map(d => `- ${d}`))

  const upcoming = [...holidays.entries()]
    .filter(([k]) => k > key(today) && k <= key(addDays(today, 30)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, name]) => {
      const [, m, d] = k.split('-').map(Number)
      return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')} (${name})`
    })
  if (upcoming.length) lines.push(`Feriados nos próximos 30 dias: ${upcoming.join(', ')}.`)
  return lines.join('\n')
}
