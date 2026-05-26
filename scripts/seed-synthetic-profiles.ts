/**
 * scripts/seed-synthetic-profiles.ts
 *
 * Genera 100 perfiles sintéticos PT/ES con transacciones realistas
 * para auditoría y simulación masiva en staging.
 *
 * Uso:
 *   ALLOW_SYNTHETIC_SEED=1 npx tsx scripts/seed-synthetic-profiles.ts
 *
 * Lee credenciales de .env.local vía las mismas variables que la app:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *
 * Refusa ejecutarse si la URL parece producción.
 *
 * Para limpiar: scripts/cleanup-synthetic-profiles.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

// ─── Configuración fija ────────────────────────────────────────────────────

const EMAIL_DOMAIN = 'audit.andgcore.test'
const TOTAL_USERS = 100
const RNG_SEED = 20260526 // determinista — re-runs generan los mismos perfiles

// Distribuciones (suman 100)
const COUNTRY_PLAN: Record<Country, number> = { PT: 60, ES: 40 }
const AGE_PLAN: Record<AgeBucket, number> = {
  '25-34': 25,
  '35-49': 40,
  '50-64': 25,
  '65-80': 10,
}
const ARCHETYPE_PLAN: Record<Archetype, number> = {
  ahorrador: 20,
  gastador: 25,
  impulsivo: 15,
  conservador: 20,
  endeudado: 20,
}

// ─── Tipos ─────────────────────────────────────────────────────────────────

type Country = 'PT' | 'ES'
type AgeBucket = '25-34' | '35-49' | '50-64' | '65-80'
type Archetype = 'ahorrador' | 'gastador' | 'impulsivo' | 'conservador' | 'endeudado'
type PowerLaw = 'vital' | 'important' | 'discretionary' | 'leak' | 'debt'

interface Assignment {
  index: number
  email: string
  name: string
  country: Country
  age: number
  archetype: Archetype
  language: 'es' | 'pt'
  monthsBack: number
  monthlyNet: number
}

interface TxRow {
  user_id: string
  amount: number
  type: 'income' | 'expense'
  category: string
  power_law: PowerLaw
  is_leak: boolean
  date: string
  description: string
}

// ─── RNG determinista (mulberry32) ─────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rng = mulberry32(RNG_SEED)
const rand = () => rng()
const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min
const randFloat = (min: number, max: number) => rand() * (max - min) + min
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)]
}
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// ─── Safety guards ─────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('❌ Faltan NEXT_PUBLIC_SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno.')
  process.exit(1)
}

if (/prod|production/i.test(SUPABASE_URL)) {
  console.error('❌ La URL parece producción. Abortando por seguridad:', SUPABASE_URL)
  process.exit(1)
}

if (process.env.ALLOW_SYNTHETIC_SEED !== '1') {
  console.error('❌ Falta ALLOW_SYNTHETIC_SEED=1 para confirmar la ejecución.')
  console.error('   URL objetivo:', SUPABASE_URL)
  console.error('   Esto creará 100 usuarios con email synth_*@' + EMAIL_DOMAIN)
  process.exit(1)
}

console.log('🌱 Sembrando 100 perfiles sintéticos contra:', SUPABASE_URL)

const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ─── Datos de soporte ──────────────────────────────────────────────────────

const PT_FIRST = [
  'João', 'Maria', 'Pedro', 'Ana', 'Rui', 'Inês', 'Tiago', 'Sofia', 'Diogo',
  'Catarina', 'Miguel', 'Beatriz', 'André', 'Mariana', 'Bruno', 'Joana',
  'Ricardo', 'Carolina', 'Luís', 'Filipa', 'Nuno', 'Margarida', 'Hugo',
  'Rita', 'Vasco',
]
const PT_LAST = [
  'Silva', 'Santos', 'Oliveira', 'Costa', 'Pereira', 'Almeida', 'Ferreira',
  'Martins', 'Rodrigues', 'Ribeiro', 'Carvalho', 'Sousa', 'Pinto', 'Lopes',
  'Gomes', 'Fonseca', 'Marques', 'Cardoso',
]
const ES_FIRST = [
  'Javier', 'María', 'Carlos', 'Lucía', 'Alejandro', 'Carmen', 'Miguel',
  'Ana', 'David', 'Laura', 'Antonio', 'Elena', 'Manuel', 'Paula',
  'Francisco', 'Marta', 'Jorge', 'Sara', 'Diego', 'Cristina', 'Pablo',
  'Isabel', 'Sergio', 'Nuria', 'Raúl',
]
const ES_LAST = [
  'García', 'López', 'Martínez', 'Sánchez', 'Pérez', 'Gómez', 'Fernández',
  'Rodríguez', 'Hernández', 'Díaz', 'Moreno', 'Álvarez', 'Romero', 'Jiménez',
  'Ruiz', 'Torres', 'Navarro', 'Castro',
]

const SUPER_BRANDS: Record<Country, string[]> = {
  PT: ['Pingo Doce', 'Continente', 'Lidl', 'Auchan', 'Mini-Preço'],
  ES: ['Mercadona', 'Carrefour', 'Lidl', 'Dia', 'Alcampo'],
}
const TELECOM_BRANDS: Record<Country, string[]> = {
  PT: ['MEO', 'NOS', 'Vodafone PT'],
  ES: ['Movistar', 'Vodafone', 'Orange', 'MásMóvil'],
}
const ENERGY_BRANDS: Record<Country, string[]> = {
  PT: ['EDP', 'Galp Energia', 'Endesa PT'],
  ES: ['Iberdrola', 'Endesa', 'Naturgy', 'Repsol'],
}
const SUBSCRIPTIONS = [
  'Netflix', 'Spotify', 'Disney+', 'HBO Max', 'YouTube Premium',
  'Amazon Prime', 'Apple One', 'iCloud+', 'Adobe Creative Cloud',
  'Audible', 'Duolingo Plus', 'Microsoft 365', 'Patreon', 'Twitch Sub',
]
const RESTAURANTS_DESCS = [
  'Comida en restaurante', 'Almuerzo de trabajo', 'Cena con amigos',
  'Pizza para llevar', 'Café y croissant', 'Brunch fin de semana',
  'Hamburguesa rápida', 'Sushi delivery', 'Tapas en el barrio',
]
const OCIO_DESCS = [
  'Cine', 'Concierto', 'Bar fin de semana', 'Discoteca', 'Evento deportivo',
  'Escape room', 'Bolera', 'Museo / exposición',
]
const ROPA_DESCS = [
  'Zara', 'H&M', 'Mango', 'Pull&Bear', 'Bershka', 'Uniqlo',
  'Decathlon', 'Nike', 'Adidas', 'Compra online ropa',
]
const TRANSPORTE_DESCS = [
  'Gasolina', 'Diésel', 'Peaje autopista', 'Parking', 'Metro / pase mensual',
  'Bus / pase mensual', 'Uber', 'Taxi', 'Bolt',
]
const SALUD_DESCS = [
  'Farmacia', 'Consulta médica', 'Dentista', 'Análisis clínicos',
  'Óptica', 'Fisioterapia',
]

// ─── Catálogo de categorías y reglas por arquetipo ─────────────────────────

interface CategoryRule {
  pctOfIncome: [number, number] // rango como fracción del ingreso mensual neto
  txPerMonth: [number, number]
  powerLaw: PowerLaw
  isLeak: boolean
}

type ExpenseProfile = Record<string, CategoryRule>

// Las categorías que aparecen para todos los arquetipos:
function baseProfile(): ExpenseProfile {
  return {
    alquiler:         { pctOfIncome: [0.28, 0.36], txPerMonth: [1, 1], powerLaw: 'vital',         isLeak: false },
    supermercado:     { pctOfIncome: [0.10, 0.18], txPerMonth: [4, 8], powerLaw: 'vital',         isLeak: false },
    transporte:       { pctOfIncome: [0.04, 0.10], txPerMonth: [2, 5], powerLaw: 'important',     isLeak: false },
    energia:          { pctOfIncome: [0.03, 0.07], txPerMonth: [1, 2], powerLaw: 'important',     isLeak: false },
    telecomunicaciones:{ pctOfIncome:[0.02, 0.05], txPerMonth: [1, 2], powerLaw: 'important',     isLeak: false },
    salud:            { pctOfIncome: [0.01, 0.05], txPerMonth: [0, 2], powerLaw: 'important',     isLeak: false },
    restaurantes:     { pctOfIncome: [0.02, 0.06], txPerMonth: [2, 5], powerLaw: 'discretionary', isLeak: false },
    ocio:             { pctOfIncome: [0.01, 0.05], txPerMonth: [1, 4], powerLaw: 'discretionary', isLeak: false },
    ropa:             { pctOfIncome: [0.01, 0.04], txPerMonth: [0, 3], powerLaw: 'discretionary', isLeak: false },
    suscripciones:    { pctOfIncome: [0.01, 0.03], txPerMonth: [1, 3], powerLaw: 'leak',          isLeak: false },
  }
}

function expenseProfile(archetype: Archetype): ExpenseProfile {
  const base = baseProfile()
  switch (archetype) {
    case 'ahorrador':
      // Disciplinado: gasta poco discrecional, fugas mínimas → tasa ahorro >15%.
      base.alquiler.pctOfIncome = [0.25, 0.33]
      base.supermercado.pctOfIncome = [0.09, 0.14]
      base.restaurantes.pctOfIncome = [0.01, 0.03]
      base.restaurantes.txPerMonth = [1, 3]
      base.ocio.pctOfIncome = [0.01, 0.025]
      base.ocio.txPerMonth = [0, 2]
      base.ropa.pctOfIncome = [0.005, 0.02]
      base.ropa.txPerMonth = [0, 1]
      base.suscripciones.pctOfIncome = [0.005, 0.015]
      base.suscripciones.txPerMonth = [1, 2]
      return base

    case 'gastador':
      // Tasa ahorro <5%; fugas 15-25% del gasto total via restaurantes/suscripciones/ocio/ropa.
      base.restaurantes.pctOfIncome = [0.08, 0.14]
      base.restaurantes.txPerMonth = [8, 16]
      base.restaurantes.isLeak = true
      base.ocio.pctOfIncome = [0.05, 0.10]
      base.ocio.txPerMonth = [3, 8]
      base.ocio.isLeak = true
      base.ropa.pctOfIncome = [0.04, 0.09]
      base.ropa.txPerMonth = [2, 5]
      base.ropa.isLeak = true
      base.suscripciones.pctOfIncome = [0.03, 0.06]
      base.suscripciones.txPerMonth = [3, 6]
      base.suscripciones.isLeak = true
      return base

    case 'impulsivo':
      // Variabilidad alta semana a semana: las categorías discrecionales explotan
      // o se calman. La función `genMonthForUser` aplica un spikeFactor extra.
      base.restaurantes.pctOfIncome = [0.03, 0.18]
      base.restaurantes.txPerMonth = [3, 14]
      base.restaurantes.isLeak = true
      base.ocio.pctOfIncome = [0.02, 0.16]
      base.ocio.txPerMonth = [1, 9]
      base.ocio.isLeak = true
      base.ropa.pctOfIncome = [0.01, 0.22]
      base.ropa.txPerMonth = [1, 6]
      base.ropa.isLeak = true
      base.suscripciones.pctOfIncome = [0.02, 0.10]
      base.suscripciones.txPerMonth = [2, 6]
      base.suscripciones.isLeak = true
      return base

    case 'conservador':
      // Predecible y estable. Sin meta agresiva. Gasto discrecional bajo y constante.
      base.alquiler.pctOfIncome = [0.30, 0.35]
      base.supermercado.pctOfIncome = [0.13, 0.17]
      base.restaurantes.pctOfIncome = [0.02, 0.04]
      base.restaurantes.txPerMonth = [2, 4]
      base.ocio.pctOfIncome = [0.02, 0.04]
      base.ocio.txPerMonth = [1, 3]
      base.ropa.pctOfIncome = [0.01, 0.03]
      base.ropa.txPerMonth = [0, 2]
      base.suscripciones.pctOfIncome = [0.01, 0.025]
      base.suscripciones.txPerMonth = [1, 3]
      return base

    case 'endeudado':
      // Ratio deuda/ingreso >40%: 30-38% pago_deuda + 6-10% intereses. Tasa ahorro negativa o nula.
      base.alquiler.pctOfIncome = [0.28, 0.34]
      base.restaurantes.pctOfIncome = [0.03, 0.06]
      base.ocio.pctOfIncome = [0.02, 0.04]
      base.ropa.pctOfIncome = [0.01, 0.03]
      base.suscripciones.pctOfIncome = [0.015, 0.035]
      base.suscripciones.txPerMonth = [2, 4]
      // Añadimos categorías de deuda:
      base.pago_deuda     = { pctOfIncome: [0.25, 0.35], txPerMonth: [1, 1], powerLaw: 'debt', isLeak: false }
      base.intereses_deuda= { pctOfIncome: [0.06, 0.10], txPerMonth: [1, 1], powerLaw: 'debt', isLeak: false }
      return base
  }
}

// ─── Fechas ────────────────────────────────────────────────────────────────

const TODAY = new Date('2026-05-26T12:00:00Z')

function isoDate(year: number, month: number, day: number): string {
  // month es 1-12
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

function daysInMonth(year: number, monthIdx0: number): number {
  return new Date(Date.UTC(year, monthIdx0 + 1, 0)).getUTCDate()
}

function monthsBackList(monthsBack: number): { year: number; month: number }[] {
  // Devuelve la lista de (año, mes 1-12) cubriendo los últimos `monthsBack` meses
  // incluyendo el actual.
  const out: { year: number; month: number }[] = []
  const start = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - (monthsBack - 1), 1))
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 })
  }
  return out
}

// ─── Distribución de asignaciones ──────────────────────────────────────────

function buildAssignments(): Assignment[] {
  const countries: Country[] = []
  ;(Object.entries(COUNTRY_PLAN) as [Country, number][]).forEach(([c, n]) => {
    for (let i = 0; i < n; i++) countries.push(c)
  })

  const ages: AgeBucket[] = []
  ;(Object.entries(AGE_PLAN) as [AgeBucket, number][]).forEach(([a, n]) => {
    for (let i = 0; i < n; i++) ages.push(a)
  })

  const archetypes: Archetype[] = []
  ;(Object.entries(ARCHETYPE_PLAN) as [Archetype, number][]).forEach(([a, n]) => {
    for (let i = 0; i < n; i++) archetypes.push(a)
  })

  const c = shuffle(countries)
  const a = shuffle(ages)
  const k = shuffle(archetypes)

  const assignments: Assignment[] = []
  for (let i = 0; i < TOTAL_USERS; i++) {
    const country = c[i]
    const ageBucket = a[i]
    const archetype = k[i]

    const ageRange: Record<AgeBucket, [number, number]> = {
      '25-34': [25, 34],
      '35-49': [35, 49],
      '50-64': [50, 64],
      '65-80': [65, 80],
    }
    const age = randInt(ageRange[ageBucket][0], ageRange[ageBucket][1])

    const firstPool = country === 'PT' ? PT_FIRST : ES_FIRST
    const lastPool = country === 'PT' ? PT_LAST : ES_LAST
    const name = `${pick(firstPool)} ${pick(lastPool)}`

    const [minSal, maxSal] = salaryRange(country, archetype)
    const monthlyNet = Math.round(randFloat(minSal, maxSal))

    const monthsBack = randInt(3, 6)

    assignments.push({
      index: i + 1,
      email: `synth_${String(i + 1).padStart(3, '0')}@${EMAIL_DOMAIN}`,
      name,
      country,
      age,
      archetype,
      language: country === 'PT' ? 'pt' : 'es',
      monthsBack,
      monthlyNet,
    })
  }
  return assignments
}

function salaryRange(country: Country, archetype: Archetype): [number, number] {
  if (country === 'PT') {
    switch (archetype) {
      case 'ahorrador':   return [1800, 2800]
      case 'gastador':    return [1800, 3500]
      case 'impulsivo':   return [1400, 2600]
      case 'conservador': return [1400, 2400]
      case 'endeudado':   return [800,  1800]
    }
  } else {
    switch (archetype) {
      case 'ahorrador':   return [2200, 3500]
      case 'gastador':    return [2200, 4500]
      case 'impulsivo':   return [1800, 3200]
      case 'conservador': return [1800, 2800]
      case 'endeudado':   return [1100, 2200]
    }
  }
}

// ─── Goals y miedos por arquetipo ──────────────────────────────────────────

function goalForArchetype(archetype: Archetype): { goal: string; horizonMonths: number } {
  const opts: Record<Archetype, { goal: string; horizonMonths: number }[]> = {
    ahorrador: [
      { goal: 'Acumular 12 meses de gastos en reserva de emergencia', horizonMonths: 18 },
      { goal: 'Comprar piso sin hipoteca con ahorros propios',         horizonMonths: 60 },
      { goal: 'Independencia financiera antes de los 55',              horizonMonths: 120 },
    ],
    gastador: [
      { goal: 'Crear mi primer fondo de emergencia de 3 meses',        horizonMonths: 12 },
      { goal: 'Cerrar el mes con ahorro positivo de forma constante',  horizonMonths: 6 },
      { goal: 'Reducir gastos en restaurantes y suscripciones',        horizonMonths: 6 },
    ],
    impulsivo: [
      { goal: 'Identificar y reducir mis fugas semanales',             horizonMonths: 9 },
      { goal: 'Aprender a presupuestar y mantener un plan estable',    horizonMonths: 12 },
      { goal: 'Ahorrar para un viaje grande sin descuadrar el mes',    horizonMonths: 9 },
    ],
    conservador: [
      { goal: 'Proteger mi reserva actual y rentabilizarla',           horizonMonths: 24 },
      { goal: 'Planificar mi jubilación con tranquilidad',             horizonMonths: 60 },
      { goal: 'Mantener mi nivel de vida con ingresos estables',       horizonMonths: 36 },
    ],
    endeudado: [
      { goal: 'Salir de deudas en menos de 24 meses',                  horizonMonths: 24 },
      { goal: 'Refinanciar y reducir intereses mensuales',             horizonMonths: 12 },
      { goal: 'Recuperar el control y volver a ahorrar',               horizonMonths: 18 },
    ],
  }
  return pick(opts[archetype])
}

function fearForArchetype(archetype: Archetype): string {
  const fears: Record<Archetype, string[]> = {
    ahorrador:   ['Perder el control sobre mi futuro', 'No tener suficiente para retirarme'],
    gastador:    ['No llegar a fin de mes', 'No tener nada ahorrado si me despiden'],
    impulsivo:   ['Repetir los mismos errores cada mes', 'Endeudarme por compras impulsivas'],
    conservador: ['Que la inflación me coma los ahorros', 'Tomar una mala decisión financiera'],
    endeudado:   ['No salir nunca de las deudas', 'Que mi familia se entere de mis deudas'],
  }
  return pick(fears[archetype])
}

// ─── Generación de transacciones ───────────────────────────────────────────

function pickDayInMonth(year: number, month: number): number {
  return randInt(1, daysInMonth(year, month - 1))
}

function genIncomeTransactions(userId: string, a: Assignment): TxRow[] {
  const rows: TxRow[] = []
  const months = monthsBackList(a.monthsBack)
  for (const { year, month } of months) {
    // Día de cobro: 25-28
    const day = randInt(25, Math.min(28, daysInMonth(year, month - 1)))
    rows.push({
      user_id: userId,
      amount: a.monthlyNet,
      type: 'income',
      category: 'salario',
      power_law: 'vital',
      is_leak: false,
      date: isoDate(year, month, day),
      description: 'Nómina mensual',
    })

    // Subsidios / pagas extra
    if (a.country === 'PT') {
      if (month === 6) {
        rows.push({
          user_id: userId,
          amount: a.monthlyNet,
          type: 'income',
          category: 'salario',
          power_law: 'vital',
          is_leak: false,
          date: isoDate(year, month, randInt(20, 25)),
          description: 'Subsídio de férias',
        })
      }
      if (month === 11) {
        rows.push({
          user_id: userId,
          amount: a.monthlyNet,
          type: 'income',
          category: 'salario',
          power_law: 'vital',
          is_leak: false,
          date: isoDate(year, month, randInt(15, 22)),
          description: 'Subsídio de Natal',
        })
      }
    } else {
      if (month === 7) {
        rows.push({
          user_id: userId,
          amount: a.monthlyNet,
          type: 'income',
          category: 'salario',
          power_law: 'vital',
          is_leak: false,
          date: isoDate(year, month, randInt(20, 25)),
          description: 'Paga extra de verano',
        })
      }
      if (month === 12) {
        rows.push({
          user_id: userId,
          amount: a.monthlyNet,
          type: 'income',
          category: 'salario',
          power_law: 'vital',
          is_leak: false,
          date: isoDate(year, month, randInt(15, 22)),
          description: 'Paga extra de Navidad',
        })
      }
    }
  }
  return rows
}

function descriptionFor(category: string, country: Country): string {
  switch (category) {
    case 'alquiler':           return 'Alquiler vivienda'
    case 'supermercado':       return `Compra ${pick(SUPER_BRANDS[country])}`
    case 'transporte':         return pick(TRANSPORTE_DESCS)
    case 'energia':            return `Factura ${pick(ENERGY_BRANDS[country])}`
    case 'telecomunicaciones': return `Factura ${pick(TELECOM_BRANDS[country])}`
    case 'salud':              return pick(SALUD_DESCS)
    case 'restaurantes':       return pick(RESTAURANTS_DESCS)
    case 'ocio':               return pick(OCIO_DESCS)
    case 'ropa':               return pick(ROPA_DESCS)
    case 'suscripciones':      return `Suscripción ${pick(SUBSCRIPTIONS)}`
    case 'pago_deuda':         return 'Cuota préstamo personal'
    case 'intereses_deuda':    return 'Intereses préstamo personal'
    default:                   return category
  }
}

function genExpenseTransactions(userId: string, a: Assignment): TxRow[] {
  const rows: TxRow[] = []
  const profile = expenseProfile(a.archetype)
  const months = monthsBackList(a.monthsBack)

  for (const { year, month } of months) {
    // Factor de "spike" del mes para impulsivos: 0.3–2.5
    const spike = a.archetype === 'impulsivo' ? randFloat(0.3, 2.5) : 1

    for (const [category, rule] of Object.entries(profile)) {
      // ¿Aplica spike a esta categoría? Sólo a discrecionales/leaks
      const applySpike = rule.powerLaw === 'discretionary' || rule.powerLaw === 'leak'
      const localFactor = applySpike ? spike : 1

      const pct = randFloat(rule.pctOfIncome[0], rule.pctOfIncome[1]) * localFactor
      const total = Math.max(0, a.monthlyNet * pct)
      if (total < 1) continue

      const baseCount = randInt(rule.txPerMonth[0], rule.txPerMonth[1])
      // Si hay spike fuerte hacia arriba, generamos más transacciones (impulsivo)
      const count = Math.max(1, Math.round(baseCount * (applySpike ? Math.max(0.5, spike) : 1)))

      // Repartir total en `count` montos con leve variación
      const weights: number[] = []
      let sumW = 0
      for (let i = 0; i < count; i++) {
        const w = randFloat(0.6, 1.4)
        weights.push(w)
        sumW += w
      }
      for (let i = 0; i < count; i++) {
        const amount = Math.round(((total * weights[i]) / sumW) * 100) / 100
        if (amount < 0.5) continue
        rows.push({
          user_id: userId,
          amount,
          type: 'expense',
          category,
          power_law: rule.powerLaw,
          is_leak: rule.isLeak,
          date: isoDate(year, month, pickDayInMonth(year, month)),
          description: descriptionFor(category, a.country),
        })
      }
    }
  }
  return rows
}

function genOneOffEvents(userId: string, a: Assignment): TxRow[] {
  const rows: TxRow[] = []
  const months = monthsBackList(a.monthsBack)

  // 25% de usuarios: bono anual (mes aleatorio del histórico)
  if (rand() < 0.25 && months.length > 0) {
    const m = pick(months)
    rows.push({
      user_id: userId,
      amount: Math.round(randFloat(1000, 3000)),
      type: 'income',
      category: 'bono',
      power_law: 'important',
      is_leak: false,
      date: isoDate(m.year, m.month, pickDayInMonth(m.year, m.month)),
      description: 'Bono anual',
    })
  }

  // 30% de usuarios: devolución hacienda (mayo-julio si está cubierto)
  if (rand() < 0.30) {
    const window = months.filter(m => m.month === 5 || m.month === 6 || m.month === 7)
    if (window.length > 0) {
      const m = pick(window)
      rows.push({
        user_id: userId,
        amount: Math.round(randFloat(300, 1200)),
        type: 'income',
        category: a.country === 'PT' ? 'reembolso_irs' : 'devolucion_renta',
        power_law: 'important',
        is_leak: false,
        date: isoDate(m.year, m.month, pickDayInMonth(m.year, m.month)),
        description: a.country === 'PT' ? 'Reembolso IRS' : 'Devolución renta',
      })
    }
  }

  // 20% de usuarios: gasto médico inesperado
  if (rand() < 0.20 && months.length > 0) {
    const m = pick(months)
    rows.push({
      user_id: userId,
      amount: Math.round(randFloat(200, 1500)),
      type: 'expense',
      category: 'salud',
      power_law: 'important',
      is_leak: false,
      date: isoDate(m.year, m.month, pickDayInMonth(m.year, m.month)),
      description: 'Gasto médico inesperado',
    })
  }

  return rows
}

// ─── Inserción en BD ───────────────────────────────────────────────────────

async function insertInBatches<T>(
  table: string,
  rows: T[],
  batchSize = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await admin.from(table).insert(slice as any)
    if (error) {
      console.error(`  ❌ Error insertando lote en ${table}:`, error.message)
      throw error
    }
  }
}

async function createUser(a: Assignment): Promise<string | null> {
  const password = `Synth!${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const { data, error } = await admin.auth.admin.createUser({
    email: a.email,
    password,
    email_confirm: true,
    user_metadata: {
      synthetic: true,
      archetype: a.archetype,
      country: a.country,
      age: a.age,
    },
  })
  if (error) {
    console.error(`  ❌ createUser falló para ${a.email}:`, error.message)
    return null
  }
  return data.user?.id ?? null
}

async function seedOne(a: Assignment): Promise<void> {
  const userId = await createUser(a)
  if (!userId) return

  const goal = goalForArchetype(a.archetype)
  const fear = fearForArchetype(a.archetype)
  const goalDate = new Date(TODAY)
  goalDate.setUTCMonth(goalDate.getUTCMonth() + goal.horizonMonths)

  // 1) Update profile (trigger auth ya creó el row vacío)
  const employmentType = pick(['empleado_cuenta_ajena', 'autonomo', 'funcionario', 'empleado_cuenta_ajena'])
  const { error: pErr } = await admin
    .from('profiles')
    .update({
      name: a.name,
      country: a.country,
      language: a.language,
      onboarding_done: true,
      onboarding_data: {
        financial_fear: fear,
        country: a.country,
        employment_type: employmentType,
        monthly_salary: a.monthlyNet,
        main_goal: goal.goal,
        goal_date: goalDate.toISOString().slice(0, 10),
        completed_at: new Date().toISOString(),
        _synthetic: true,
        _archetype: a.archetype,
        _age: a.age,
      },
    })
    .eq('user_id', userId)

  if (pErr) {
    console.error(`  ❌ update profile ${a.email}:`, pErr.message)
    return
  }

  // 2) Fiscal profile (bruto estimado = neto * 1.32 simplificado)
  const monthlyGross = Math.round(a.monthlyNet * 1.32)
  const { error: fErr } = await admin
    .from('fiscal_profiles')
    .insert({
      user_id: userId,
      country: a.country,
      employment_type: employmentType,
      monthly_gross: monthlyGross,
      has_holiday_bonus: a.country === 'PT' || a.country === 'ES',
      has_christmas_bonus: a.country === 'PT' || a.country === 'ES',
    })
  if (fErr) {
    console.error(`  ❌ insert fiscal_profile ${a.email}:`, fErr.message)
  }

  // 3) Transacciones
  const txs: TxRow[] = [
    ...genIncomeTransactions(userId, a),
    ...genExpenseTransactions(userId, a),
    ...genOneOffEvents(userId, a),
  ]
  // Ordenamos por fecha — opcional pero útil para inspección visual
  txs.sort((x, y) => x.date.localeCompare(y.date))

  await insertInBatches('transactions', txs, 500)

  console.log(
    `  ✓ #${String(a.index).padStart(3, '0')} ${a.email.padEnd(45)} ` +
    `${a.country} ${a.archetype.padEnd(12)} ${a.age}y ` +
    `neto=${a.monthlyNet}€ ${a.monthsBack}m tx=${txs.length}`
  )
}

// ─── Resumen final ─────────────────────────────────────────────────────────

function printPlan(assignments: Assignment[]): void {
  const byCountry: Record<string, number> = {}
  const byArchetype: Record<string, number> = {}
  const byAgeBucket: Record<string, number> = {}
  for (const a of assignments) {
    byCountry[a.country] = (byCountry[a.country] ?? 0) + 1
    byArchetype[a.archetype] = (byArchetype[a.archetype] ?? 0) + 1
    const bucket =
      a.age <= 34 ? '25-34' :
      a.age <= 49 ? '35-49' :
      a.age <= 64 ? '50-64' : '65-80'
    byAgeBucket[bucket] = (byAgeBucket[bucket] ?? 0) + 1
  }
  console.log('  País:     ', byCountry)
  console.log('  Edad:     ', byAgeBucket)
  console.log('  Arquetipo:', byArchetype)
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const assignments = buildAssignments()
  console.log(`Plan: ${assignments.length} perfiles`)
  printPlan(assignments)
  console.log('─'.repeat(80))

  let ok = 0
  let fail = 0
  for (const a of assignments) {
    try {
      await seedOne(a)
      ok++
    } catch (err) {
      fail++
      console.error(`  ❌ ${a.email} falló:`, err instanceof Error ? err.message : err)
    }
  }

  console.log('─'.repeat(80))
  console.log(`✅ Listo. Creados: ${ok} · Fallidos: ${fail}`)
}

main().catch((err) => {
  console.error('Fallo no capturado:', err)
  process.exit(1)
})
