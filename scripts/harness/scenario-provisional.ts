/**
 * scripts/harness/scenario-provisional.ts
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ PROVISIONAL — INTERFAZ ACORDADA CON AG08, IMPLEMENTACIÓN DE AG07         │
 * │                                                                          │
 * │ Cuando AG08 mergee su tanda, este módulo debe DESAPARECER y el harness   │
 * │ importará `src/lib/calculator/scenario.ts`. El loader                    │
 * │ (`scripts/harness/scenario.ts`) ya prefiere el módulo real si existe:    │
 * │ no hay que tocar el harness, solo borrar este archivo.                   │
 * │                                                                          │
 * │ Contrato (fijado en el prompt de AG07):                                  │
 * │   extractScenarioDelta(message) -> ScenarioDelta                         │
 * │   mergeScenario(prev, delta)    -> ScenarioState                         │
 * │   buildScenarioContext(state)   -> { bloque, cifrasCalculadas }          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * POR QUÉ EXISTE
 * `buildVerifiedContext` (lib/calculator/orchestrator) es SIN ESTADO: recibe un
 * único string y extrae de él los hechos. En una conversación real el usuario
 * reparte los datos entre turnos:
 *
 *   T1 "Gano 2500, gasto 1500. Quiero financiar un carro de 30000 a 36 meses."
 *   T2 "El banco me ofrece 9%."
 *
 * En T2 el orquestador ve un mensaje sin ingreso, sin gastos y sin préstamo:
 * devuelve `bloque: ""` y `cifrasCalculadas: []`. El 9% se pierde (el extractor
 * lo etiqueta como `""`). El modelo se queda sin cifras verificadas y alucina
 * ("unos 1.000 €/mes"), o cita la cuota al 7% de referencia (926,31) como si
 * fuera la real. Ese es el fallo que este módulo cierra.
 *
 * La corrección semántica clave: cuando la TAE la aporta el USUARIO, la cuota
 * deja de ser una REFERENCIA y pasa a TU REALIDAD (`cuota_credito_real`).
 *
 * Todo el CÁLCULO se delega en `lib/calculator/operations` y en
 * `lib/calculator/expenses`: aquí solo hay extracción, merge y ensamblado. No se
 * duplica una sola fórmula.
 */

import { extractInputFacts } from '../../src/lib/guardrail/extract'
import {
  findNumberMentions,
  dedupeOverlaps,
  parseDigitAmount,
} from '../../src/lib/guardrail/numbers'
import { isPercent } from '../../src/lib/guardrail/context'
import {
  sobrante,
  porcentajeDe,
  proyeccion,
  fondoEmergencia,
  regla503020,
  ratioDeuda,
  tiempoHastaMeta,
  loanPayment,
} from '../../src/lib/calculator/operations'
import { classifyExpenses, type ExpenseItem } from '../../src/lib/calculator/expenses'

// ── Supuestos (mismos valores que orchestrator.ts) ──────────────────────────
const HORIZONTE_MESES = 12
const MESES_FONDO = 6
const AHORRO_SUGERIDO_PCT = 10
export const TAE_REFERENCIA = 7

// ── Tipos del contrato ──────────────────────────────────────────────────────

export type TaeSource = 'referencia' | 'usuario'

export interface LoanScenario {
  principal?: number
  months?: number
  /** TAE en PUNTOS PORCENTUALES (9 = 9%), coherente con `loanPayment`. */
  tae?: number
  /** De dónde salió la TAE. `usuario` promueve la cuota a TU REALIDAD. */
  taeSource?: TaeSource
}

export interface ScenarioState {
  ingreso?: number
  gastos?: number
  deuda?: number
  ahorro?: number
  meta?: number
  loan?: LoanScenario
  expenses?: ExpenseItem[]
}

export type ScenarioDelta = Partial<ScenarioState>

export interface ScenarioContext {
  bloque: string
  cifrasCalculadas: number[]
}

// ── Utilidades ──────────────────────────────────────────────────────────────

function normaliza(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Coma decimal (convención es/PT): el parser del guardarraíl lee "953,99". */
function es(n: number): string {
  return String(n).replace('.', ',')
}

// ── PIEZA 1 · extractScenarioDelta ──────────────────────────────────────────

// Mismos patrones que `orchestrator.detectLoanScenario` (no exportados allí).
const LOAN_KEYWORDS =
  /\b(credito|creditos|financiar|financiacion|financiamento|cuota|cuotas|prestamo|prestamos|emprestimo|prestacao|prestacoes|parcelas?|loan|financing|installments?)\b/

const PLAZO_MESES = /(\d[\d.,]*)\s*(?:meses|mes|months?|parcelas|prestacoes|cuotas)\b/

/**
 * Contexto que convierte un porcentaje suelto en una TAE aportada por el
 * usuario. Ventana de ±40 chars alrededor de la cifra, igual criterio de
 * proximidad que `detectLabel` del guardarraíl.
 */
const TAE_CONTEXT =
  /\b(tae|tasa|taxa|juros?|interes|intereses|apr|cat|cet|banco|banca|bank|ofrece|ofrecen|oferece|offers?|rate)\b/

const TAE_WINDOW = 40

/** La TAE que el usuario declara, o undefined. Ignora "%" sin contexto de tasa. */
function detectUserTae(message: string): number | undefined {
  for (const m of dedupeOverlaps(findNumberMentions(message))) {
    if (!isPercent(message, m)) continue
    const from = Math.max(0, m.start - TAE_WINDOW)
    const to = Math.min(message.length, m.end + TAE_WINDOW)
    if (!TAE_CONTEXT.test(normaliza(message.slice(from, to)))) continue
    // Una TAE > 100 no es una TAE (sería un recorte, un reparto, otra cosa).
    if (m.value > 0 && m.value <= 100) return m.value
  }
  return undefined
}

/** Principal + plazo de un escenario de crédito. Espejo de `detectLoanScenario`. */
function detectLoanParts(
  message: string,
  ingresoGasto: Set<number>,
): { principal: number; months: number } | null {
  const n = normaliza(message)
  if (!LOAN_KEYWORDS.test(n)) return null

  const m = PLAZO_MESES.exec(n)
  if (!m) return null
  const months = parseDigitAmount(m[1])
  if (!Number.isFinite(months) || months <= 0) return null

  const candidatos = dedupeOverlaps(findNumberMentions(message))
    .filter((x) => !isPercent(message, x))
    .map((x) => x.value)
    .filter((v) => v > 0 && v !== months && !ingresoGasto.has(v))
  if (candidatos.length === 0) return null

  return { principal: Math.max(...candidatos), months }
}

/** Nombres que NO son un gasto. Mismo criterio que `orchestrator.parseExpenseList`. */
const NO_ES_GASTO =
  /\b(ingreso|ingresos|sueldo|salario|gano|gana|gasto|gastos|meta|objetivo|plazo|carro|coche|auto|vehiculo|prestamo|credito|financiar|ahorro|ahorros|deuda)\b/

function parseExpenseList(message: string): ExpenseItem[] {
  const items: ExpenseItem[] = []
  const segmentos = message.split(/[,\n]|(?<=[.!?])\s+/)
  const re =
    /([\p{L}][\p{L} ]{0,24}?)\s+(\d[\d.,]*)\s*(?:€|eur|euros?)?\s*(?:\/\s*m[eê]s|al\s+mes|por\s+m[eê]s|per\s+month|\/mo)?\s*$/iu

  for (const seg of segmentos) {
    const m = re.exec(seg.trim())
    if (!m) continue
    const name = m[1].trim()
    if (!name || NO_ES_GASTO.test(normaliza(name))) continue
    const amount = parseDigitAmount(m[2])
    if (!Number.isFinite(amount) || amount <= 0) continue
    items.push({ name, amount })
  }

  return items.length >= 2 ? items : []
}

/**
 * Lee de UN turno todo lo que aporta al escenario. Solo devuelve las claves que
 * el turno realmente menciona: lo ausente queda `undefined` y `mergeScenario`
 * conserva el valor previo.
 */
export function extractScenarioDelta(message: string): ScenarioDelta {
  const facts = extractInputFacts(message)
  const delta: ScenarioDelta = {}

  const items = parseExpenseList(message)
  const montosDeLaLista = new Set(items.map((i) => i.amount))

  for (const f of facts) {
    if (f.moneda === '%') continue // un % nunca es un monto
    if (f.etiqueta === 'ingreso' && delta.ingreso === undefined) delta.ingreso = f.valor
    if (f.etiqueta === 'gasto' && delta.gastos === undefined) {
      // "Mis gastos: netflix 15, luz 80, …" — la palabra `gastos` encabeza una
      // LISTA, y el extractor la asocia por proximidad al primer monto (15). Si
      // el supuesto agregado es en realidad uno de los ítems, no es un agregado:
      // se descarta y el `gastos` previo del estado se conserva intacto. Sin
      // este guard, un turno de entrega de gastos machaca el gasto mensual real.
      if (!montosDeLaLista.has(f.valor)) delta.gastos = f.valor
    }
    if (f.etiqueta === 'deuda' && delta.deuda === undefined) delta.deuda = f.valor
    if (f.etiqueta === 'ahorro' && delta.ahorro === undefined) delta.ahorro = f.valor
    if (f.etiqueta === 'meta' && delta.meta === undefined) delta.meta = f.valor
  }

  const ingresoGasto = new Set(
    facts.filter((f) => f.etiqueta === 'ingreso' || f.etiqueta === 'gasto').map((f) => f.valor),
  )

  const loan: LoanScenario = {}
  const parts = detectLoanParts(message, ingresoGasto)
  if (parts) {
    loan.principal = parts.principal
    loan.months = parts.months
  }
  const tae = detectUserTae(message)
  if (tae !== undefined) {
    loan.tae = tae
    loan.taeSource = 'usuario'
  }
  if (Object.keys(loan).length > 0) delta.loan = loan

  if (items.length >= 2) delta.expenses = items

  return delta
}

// ── PIEZA 2 · mergeScenario ─────────────────────────────────────────────────

/**
 * Funde el delta del turno sobre el estado acumulado. El delta MANDA sobre lo
 * previo (el usuario corrige: "en realidad gano 2800"). `loan` se funde campo a
 * campo — que el T2 aporte solo la TAE no puede borrar principal y plazo del T1.
 * Función PURA: no muta `prev`.
 */
export function mergeScenario(prev: ScenarioState, delta: ScenarioDelta): ScenarioState {
  const next: ScenarioState = { ...prev }

  if (delta.ingreso !== undefined) next.ingreso = delta.ingreso
  if (delta.gastos !== undefined) next.gastos = delta.gastos
  if (delta.deuda !== undefined) next.deuda = delta.deuda
  if (delta.ahorro !== undefined) next.ahorro = delta.ahorro
  if (delta.meta !== undefined) next.meta = delta.meta
  if (delta.expenses !== undefined) next.expenses = delta.expenses

  if (delta.loan) {
    next.loan = { ...(prev.loan ?? {}), ...delta.loan }
  }

  return next
}

// ── PIEZA 3 · buildScenarioContext ──────────────────────────────────────────

interface Linea {
  etiqueta: string
  valor: number
  formula: string
}

// Coma decimal en TODA cifra del bloque: si el modelo copia "953.99", el parser
// del guardarraíl (convención es/LatAm) lo trocea en 953 y 99 y no aprueba la
// cifra. Con "953,99" la lee entera. Los enteros salen igual.
const render = (l: Linea) => `- ${l.etiqueta}: ${es(l.valor)} € (${l.formula})`

/**
 * Ensambla el bloque verificado a partir del ESTADO ACUMULADO (no de un turno).
 * Misma semántica de dos secciones que `buildVerifiedContext`:
 *
 *   a) TU REALIDAD        → cifras del usuario y derivadas. Alimentan grounding.
 *   b) REFERENCIAS ESTÁNDAR → normativas. NO alimentan grounding (salvo la cuota
 *      simulada, igual que en el orquestador).
 *
 * Diferencia sustantiva: si `loan.taeSource === 'usuario'`, la cuota se calcula
 * con SU tasa y se emite como `cuota_credito_real` dentro de TU REALIDAD. Con la
 * TAE de referencia sigue siendo `referencia_cuota_credito`.
 */
export function buildScenarioContext(state: ScenarioState): ScenarioContext {
  const realidad: Linea[] = []
  const referencias: string[] = []
  const refLine = (etiqueta: string, pct: number, monto: number) =>
    `- ${etiqueta}: ${pct}% del ingreso (= ${monto} €/mes en tu caso)`

  const { ingreso, gastos, deuda, meta } = state
  let capacidadMensual: number | null = null

  if (ingreso !== undefined && gastos !== undefined) {
    realidad.push({ etiqueta: 'ingreso_mensual', valor: ingreso, formula: 'dato que aportaste' })
    realidad.push({ etiqueta: 'gastos_mensuales', valor: gastos, formula: 'dato que aportaste' })

    const s = sobrante(ingreso, gastos)
    if (s.ok) {
      realidad.push({
        etiqueta: 'sobrante_mensual',
        valor: s.valor,
        formula: `ingreso ${ingreso} − gastos ${gastos}`,
      })
      if (s.valor > 0) {
        capacidadMensual = s.valor
        const anual = proyeccion(s.valor, HORIZONTE_MESES)
        if (anual.ok) {
          realidad.push({
            etiqueta: 'capacidad_ahorro_anual',
            valor: anual.valor,
            formula: `sobrante ${s.valor} × 12`,
          })
        }
      }
      const ref = porcentajeDe(ingreso, AHORRO_SUGERIDO_PCT)
      if (ref.ok) {
        referencias.push(refLine('referencia_ahorro_sugerido', AHORRO_SUGERIDO_PCT, ref.valor))
      }
    }
  } else if (ingreso !== undefined) {
    realidad.push({ etiqueta: 'ingreso_mensual', valor: ingreso, formula: 'dato que aportaste' })
    const r = regla503020(ingreso)
    if (r.ok) {
      referencias.push(refLine('referencia_necesidades', 50, r.necesidades))
      referencias.push(refLine('referencia_ocio', 30, r.ocio))
      referencias.push(refLine('referencia_ahorro', 20, r.ahorro))
    }
  }

  if (gastos !== undefined && ingreso === undefined) {
    realidad.push({ etiqueta: 'gastos_mensuales', valor: gastos, formula: 'dato que aportaste' })
    const f = fondoEmergencia(gastos, MESES_FONDO)
    if (f.ok) {
      realidad.push({
        etiqueta: 'reserva_imprevistos_objetivo',
        valor: f.valor,
        formula: `gastos ${gastos} × 6 meses`,
      })
    }
  }

  if (deuda !== undefined && ingreso !== undefined) {
    const rd = ratioDeuda(deuda, ingreso * 12)
    if (rd.ok) {
      realidad.push({
        etiqueta: 'ratio_deuda_ingreso',
        valor: rd.valor,
        formula: `${rd.formula} (ingreso anualizado ${ingreso} × 12)`,
      })
    }
  }

  if (meta !== undefined && capacidadMensual !== null && capacidadMensual > 0) {
    const t = tiempoHastaMeta(meta, capacidadMensual)
    if (t.ok) {
      realidad.push({
        etiqueta: 'meses_hasta_meta',
        valor: t.valor,
        formula: `meta ${meta} ÷ capacidad ${capacidadMensual}/mes`,
      })
    }
  }

  // ── Crédito: la TAE del usuario manda sobre la de referencia ──────────────
  const cuotaCifras: number[] = []
  const loan = state.loan
  if (loan?.principal !== undefined && loan.months !== undefined) {
    const usuario = loan.taeSource === 'usuario' && loan.tae !== undefined
    const tae = usuario ? (loan.tae as number) : TAE_REFERENCIA
    const cuota = loanPayment({ principal: loan.principal, months: loan.months, annualRatePct: tae })
    if (cuota.ok) {
      if (usuario) {
        // Su tasa real → deja de ser referencia. Entra en TU REALIDAD con su
        // etiqueta propia, y el modelo puede citarla como la cuota exacta.
        realidad.push({
          etiqueta: 'cuota_credito_real',
          valor: cuota.valor,
          formula: `${loan.principal} a ${loan.months} meses con TAE ${tae}% (tasa que te dio tu banco)`,
        })
      } else {
        referencias.push(
          `- referencia_cuota_credito: ${es(cuota.valor)} €/mes (simulación con TAE de referencia ~${TAE_REFERENCIA}% — NO es la tasa real del usuario; monto ${loan.principal} a ${loan.months} meses)`,
        )
        cuotaCifras.push(cuota.valor)
      }
    }
  }

  // ── Lista de gastos → clasificación + recorte del 50% de los no vitales ───
  const gastosSinClasificar: string[] = []
  const itemCifras: number[] = []
  const items = state.expenses ?? []
  if (items.length >= 2) {
    const cls = classifyExpenses(items)
    itemCifras.push(...items.map((i) => i.amount))
    const lista = (g: ExpenseItem[]) => g.map((i) => `${i.name} ${i.amount}`).join(', ')

    if (cls.vitales.items.length > 0) {
      realidad.push({ etiqueta: 'gastos_vitales', valor: cls.vitales.total, formula: lista(cls.vitales.items) })
    }
    if (cls.noVitales.items.length > 0) {
      realidad.push({ etiqueta: 'gastos_no_vitales', valor: cls.noVitales.total, formula: lista(cls.noVitales.items) })
      realidad.push({
        etiqueta: 'recorte_propuesto_50pct',
        valor: cls.recortePropuesto,
        formula: 'supuesto: reducir no vitales a la mitad',
      })
      if (capacidadMensual !== null) {
        realidad.push({
          etiqueta: 'nueva_capacidad',
          valor: round2(capacidadMensual + cls.recortePropuesto),
          formula: `sobrante ${es(capacidadMensual)} + recorte ${es(cls.recortePropuesto)}`,
        })
      }
    }
    if (cls.desconocidos.items.length > 0) {
      gastosSinClasificar.push(
        `gastos_sin_clasificar: ${lista(cls.desconocidos.items)} — preguntar si son fijos imprescindibles`,
      )
    }
  }

  if (realidad.length === 0 && referencias.length === 0 && gastosSinClasificar.length === 0) {
    return { bloque: '', cifrasCalculadas: [] }
  }

  const secciones: string[] = []
  if (realidad.length > 0 || gastosSinClasificar.length > 0) {
    secciones.push(
      'TU REALIDAD (datos verificados — usa EXCLUSIVAMENTE estas cifras, no inventes ni redondees a otras):',
      ...realidad.map(render),
      ...gastosSinClasificar.map((l) => `- ${l}`),
    )
  }
  if (referencias.length > 0) {
    if (secciones.length > 0) secciones.push('')
    secciones.push(
      'REFERENCIAS ESTÁNDAR (NO son datos del usuario; solo puedes citarlas etiquetadas como referencia, nunca como su cifra real; NO las menciones en preguntas de capacidad):',
      ...referencias,
    )
  }

  const cifrasCalculadas = [...realidad.map((l) => l.valor), ...cuotaCifras, ...itemCifras]
  return { bloque: secciones.join('\n'), cifrasCalculadas }
}
