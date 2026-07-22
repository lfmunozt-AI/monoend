/**
 * scripts/lib/synthetic-profiles.ts
 *
 * Núcleo PURO del banco de 100 perfiles sintéticos PT/ES.
 *
 * Extraído de `scripts/seed-synthetic-profiles.ts` para que el seeder y el
 * harness de regresión compartan UNA sola fuente de verdad. Sin Supabase, sin
 * env vars, sin efectos de módulo: importable desde cualquier script.
 *
 * DETERMINISMO — el `rng` se INYECTA, no se crea aquí. El seeder pasa su propia
 * instancia (`mulberry32(RNG_SEED)`) y `buildAssignments` sigue siendo su primer
 * consumidor, así que el orden de consumo del PRNG —y por tanto los 100 perfiles
 * y sus transacciones— es idéntico al de antes de la extracción.
 */

// ─── Tipos ─────────────────────────────────────────────────────────────────

export type Country = 'PT' | 'ES'
export type AgeBucket = '25-34' | '35-49' | '50-64' | '65-80'
export type Archetype = 'ahorrador' | 'gastador' | 'impulsivo' | 'conservador' | 'endeudado'

export interface Assignment {
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

// ─── Configuración fija ────────────────────────────────────────────────────

export const EMAIL_DOMAIN = 'audit.andgcore.test'
export const TOTAL_USERS = 100
export const RNG_SEED = 20260526 // determinista — re-runs generan los mismos perfiles

// Distribuciones (suman 100)
export const COUNTRY_PLAN: Record<Country, number> = { PT: 60, ES: 40 }
export const AGE_PLAN: Record<AgeBucket, number> = {
  '25-34': 25,
  '35-49': 40,
  '50-64': 25,
  '65-80': 10,
}
export const ARCHETYPE_PLAN: Record<Archetype, number> = {
  ahorrador: 20,
  gastador: 25,
  impulsivo: 15,
  conservador: 20,
  endeudado: 20,
}

// ─── RNG determinista (mulberry32) ─────────────────────────────────────────

export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Helpers ligados a un `rng` concreto. Mismo cuerpo que los del seeder. */
export function rngHelpers(rand: Rng) {
  const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min
  const randFloat = (min: number, max: number) => rand() * (max - min) + min
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]
  const shuffle = <T,>(arr: T[]): T[] => {
    const out = [...arr]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }
  return { randInt, randFloat, pick, shuffle }
}

// ─── Nombres ───────────────────────────────────────────────────────────────

export const PT_FIRST = [
  'João', 'Maria', 'Pedro', 'Ana', 'Rui', 'Inês', 'Tiago', 'Sofia', 'Diogo',
  'Catarina', 'Miguel', 'Beatriz', 'André', 'Mariana', 'Bruno', 'Joana',
  'Ricardo', 'Carolina', 'Luís', 'Filipa', 'Nuno', 'Margarida', 'Hugo',
  'Rita', 'Vasco',
]
export const PT_LAST = [
  'Silva', 'Santos', 'Oliveira', 'Costa', 'Pereira', 'Almeida', 'Ferreira',
  'Martins', 'Rodrigues', 'Ribeiro', 'Carvalho', 'Sousa', 'Pinto', 'Lopes',
  'Gomes', 'Fonseca', 'Marques', 'Cardoso',
]
export const ES_FIRST = [
  'Javier', 'María', 'Carlos', 'Lucía', 'Alejandro', 'Carmen', 'Miguel',
  'Ana', 'David', 'Laura', 'Antonio', 'Elena', 'Manuel', 'Paula',
  'Francisco', 'Marta', 'Jorge', 'Sara', 'Diego', 'Cristina', 'Pablo',
  'Isabel', 'Sergio', 'Nuria', 'Raúl',
]
export const ES_LAST = [
  'García', 'López', 'Martínez', 'Sánchez', 'Pérez', 'Gómez', 'Fernández',
  'Rodríguez', 'Hernández', 'Díaz', 'Moreno', 'Álvarez', 'Romero', 'Jiménez',
  'Ruiz', 'Torres', 'Navarro', 'Castro',
]

// ─── Salarios ──────────────────────────────────────────────────────────────

export function salaryRange(country: Country, archetype: Archetype): [number, number] {
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

// ─── Plan de asignación ────────────────────────────────────────────────────

const AGE_RANGE: Record<AgeBucket, [number, number]> = {
  '25-34': [25, 34],
  '35-49': [35, 49],
  '50-64': [50, 64],
  '65-80': [65, 80],
}

/**
 * Construye los 100 perfiles. Debe ser el PRIMER consumidor del `rng` para que
 * el resultado coincida con el snapshot dorado (sha256 de los 100 assignments).
 */
export function buildAssignments(rand: Rng): Assignment[] {
  const { randInt, randFloat, pick, shuffle } = rngHelpers(rand)

  const countries: Country[] = []
  ;(Object.entries(COUNTRY_PLAN) as [Country, number][]).forEach(([c, n]) => {
    for (let i = 0; i < n; i++) countries.push(c)
  })

  const ages: AgeBucket[] = []
  ;(Object.entries(AGE_PLAN) as [AgeBucket, number][]).forEach(([b, n]) => {
    for (let i = 0; i < n; i++) ages.push(b)
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

    const age = randInt(AGE_RANGE[ageBucket][0], AGE_RANGE[ageBucket][1])

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

/** Los 100 perfiles canónicos, con la semilla fija. Puro y memoizable. */
export function canonicalProfiles(): Assignment[] {
  return buildAssignments(mulberry32(RNG_SEED))
}

/** Primer perfil que cumple el predicado. Lanza si no hay ninguno. */
export function findProfile(pred: (a: Assignment) => boolean): Assignment {
  const found = canonicalProfiles().find(pred)
  if (!found) throw new Error('No hay perfil sintético que cumpla el predicado')
  return found
}

// ─── Financieros derivados ─────────────────────────────────────────────────

/**
 * Fracción del neto que cada arquetipo gasta al mes. Coherente con el generador
 * de transacciones del seeder (el `endeudado` apenas deja sobrante; el
 * `ahorrador` deja ~40%), pero AGREGADA y sin PRNG: el harness necesita un gasto
 * mensual reproducible y sin recorrer transacciones.
 */
export const SPEND_RATIO: Record<Archetype, number> = {
  ahorrador: 0.6,
  conservador: 0.7,
  impulsivo: 0.85,
  gastador: 0.9,
  endeudado: 0.95,
}

export interface ProfileFinancials {
  monthlyNet: number
  gastosMes: number
  sobrante: number
}

/**
 * Ingreso / gasto / sobrante mensuales de un perfil. Enteros: el parser de
 * cifras del guardarraíl usa convención es/LatAm y leería el punto de "1234.50"
 * como separador de millares.
 */
export function derivedFinancials(a: Assignment): ProfileFinancials {
  const gastosMes = Math.round(a.monthlyNet * SPEND_RATIO[a.archetype])
  return { monthlyNet: a.monthlyNet, gastosMes, sobrante: a.monthlyNet - gastosMes }
}
