/**
 * scripts/regression-harness.ts — AG07
 *
 * Harness de regresión CONVERSACIONAL MULTI-TURNO.
 *
 * TESIS: los miles de escenarios no se enumeran, se COMPONEN. Un escenario es
 * una secuencia de turnos; cada turno atraviesa la MISMA cadena determinista que
 * `src/app/api/chat/route.ts` ejecuta en producción:
 *
 *   1. extractScenarioDelta(mensaje)          ─┐ estado conversacional
 *   2. mergeScenario(estado, delta)            │ (lo que route.ts todavía NO hace)
 *   3. buildScenarioContext(estado)           ─┘ → { bloque, cifrasCalculadas }
 *   4. [modelo] fixtureResponse  ·  o LLM real con --live
 *   5. runGuardrail(mensaje, respuesta, { cifrasCalculadas, idioma })
 *   6. validateConsigliereOutput(texto)  → branding + severidad
 *   7. enforceOutputPolicy(texto, validación)
 *   8. disclaimer si el producto sobrevivió al enforcement
 *   9. rewriteDelegativeClosing(texto, idioma)
 *
 * Los pasos 5-9 replican `route.ts` en orden. Los pasos 1-3 son la capa con
 * estado: `buildVerifiedContext` es sin estado y pierde el contexto entre turnos
 * (ver `scripts/harness/scenario-provisional.ts`).
 *
 * MODO FIXTURE (por defecto, sin red, sin LLM, determinista)
 *   Cada turno trae `fixtureResponse`: la respuesta que el modelo "habría dado",
 *   buena o maliciosa. Probamos qué SALE del pipeline, no qué dice el modelo.
 *   Así la maquinaria determinista se testea entera sin depender del LLM.
 *
 * MODO LIVE (`--live`)
 *   Si hay LLM_API_KEY (u OPENAI_API_KEY), llama al modelo real. Los asserts de
 *   concepto y de estado siguen aplicando; los de texto literal se relajan a
 *   `expectNotContains` (un modelo real no repite literales).
 *
 * ASSERTS POR TURNO
 *   expectContains      string[]  — subcadenas que DEBEN estar en el texto final
 *   expectNotContains   string[]  — subcadenas que NO deben estar
 *   expectConcept       {c:{value,tol}} — la cifra ASOCIADA al concepto c
 *   expectFallback      boolean   — la respuesta segura sustituyó al texto
 *   expectBlocked       boolean   — el guardarraíl bloqueó alguna cifra
 *   expectScenarioState objeto    — SUBCONJUNTO del estado esperado tras el turno
 *
 * `expectConcept` existe porque el guardarraíl es VALUE-BASED, no concept-based:
 * aprueba cualquier cifra que coincida con una calculada, esté donde esté. Si el
 * sobrante real es 1000 y el modelo dice "la cuota rondaría los 1.000 €/mes", el
 * guardarraíl la aprueba (1000 está en cifrasCalculadas). Solo un assert de
 * concepto detecta que ESA cifra, junto a ESA palabra, es la incorrecta.
 *
 * Uso:
 *   npm run test:regression
 *   npm run test:regression -- --live
 *   npm run test:regression -- --filter=credito
 *   npm run test:regression -- --verbose
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { runGuardrail, rewriteDelegativeClosing, ensureSubstance } from '../src/lib/guardrail'
import {
  validateConsigliereOutput,
  enforceOutputPolicy,
  mentionsSpecificProduct,
} from '../src/lib/llm/output-validator'
import { detectLanguage, type Language } from '../src/lib/language'
import { findNumberMentions, dedupeOverlaps } from '../src/lib/guardrail/numbers'
import { isPercent } from '../src/lib/guardrail/context'

// La cadena de escenario de AG08, ya en develop. El shim provisional de AG07 se
// borró: el harness prueba SU código. Ojo — el contrato real quedó repartido:
// extractScenarioDelta/mergeScenario viven en `scenario.ts`, y buildScenarioContext
// en `orchestrator.ts`, con firma (scenario, userMessage).
import {
  extractScenarioDelta,
  mergeScenario,
  type ScenarioState,
} from '../src/lib/calculator/scenario'
import { buildScenarioContext } from '../src/lib/calculator/orchestrator'
import {
  canonicalProfiles,
  derivedFinancials,
  type Assignment,
  type Archetype,
  type Country,
} from './lib/synthetic-profiles'

// ── Tipos del formato de escenario ──────────────────────────────────────────

interface ConceptExpectation {
  value: number
  /** Tolerancia absoluta. Por defecto 1. */
  tol?: number
}

interface Turn {
  user: string
  fixtureResponse: string
  expectContains?: string[]
  expectNotContains?: string[]
  expectConcept?: Record<string, ConceptExpectation>
  expectFallback?: boolean
  expectBlocked?: boolean
  expectScenarioState?: Record<string, unknown>
}

interface ProfileSelector {
  index?: number
  archetype?: Archetype
  country?: Country
}

interface Scenario {
  name: string
  playbook: string
  language: Language
  description: string
  profile?: ProfileSelector
  turns: Turn[]
}

// ── Conceptos: la cifra que acompaña a una palabra ──────────────────────────
//
// Regex en minúsculas SIN NFD: `toLowerCase()` preserva los índices, y quitar
// acentos los desplazaría. Por eso los prefijos evitan letras acentuadas
// ("presta" cubre prestación / prestação / préstamo).

const CONCEPT_PATTERNS: Record<string, RegExp> = {
  cuota: /cuota|presta|mensualidad|mensalidade|payment|installment/g,
  sobrante: /sobrante|sobra|excedente|surplus|leftover|left over/g,
  capacidad: /capacidad|capacidade|capacity/g,
  recorte: /recorte|recortar|liberas|liberar|cortar|corte|free up/g,
  reserva: /reserva|reserve/g,
  ratio: /ratio/g,
  meta: /meta|goal|objetivo/g,
}

/** Ventana máxima (chars) entre la palabra del concepto y su cifra. */
const CONCEPT_WINDOW = 60

/**
 * La cifra asociada a un concepto.
 *
 * En ES/PT/EN la cifra SIGUE a la palabra que la nombra ("la cuota sería de
 * 953,99", "capacidad de ahorro anual es de 11808"). Por eso se prefiere el
 * número más cercano DESPUÉS del ancla; solo si no hay ninguno dentro de la
 * ventana se mira hacia atrás ("953,99 €/mes de cuota").
 *
 * Sin esta direccionalidad, en "Tu sobrante es de 984 € y tu capacidad anual es
 * de 11808 €" el ancla `capacidad` elegiría el 984 que tiene justo detrás.
 *
 * Los porcentajes se ignoran: un % nunca es el monto de un concepto.
 */
function conceptValue(text: string, concept: string): number | undefined {
  const pattern = CONCEPT_PATTERNS[concept]
  if (!pattern) throw new Error(`Concepto desconocido en expectConcept: "${concept}"`)

  const lower = text.toLowerCase()
  const anchors: number[] = []
  const re = new RegExp(pattern.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(lower)) !== null) anchors.push(m.index)
  if (anchors.length === 0) return undefined

  const numeros = dedupeOverlaps(findNumberMentions(text)).filter((n) => !isPercent(text, n))

  const closest = (dist: (a: number, n: (typeof numeros)[number]) => number): number | undefined => {
    let best: number | undefined
    let bestDist = Infinity
    for (const n of numeros) {
      for (const a of anchors) {
        const d = dist(a, n)
        if (d >= 0 && d <= CONCEPT_WINDOW && d < bestDist) {
          bestDist = d
          best = n.value
        }
      }
    }
    return best
  }

  // 1ª pasada: la cifra va después del ancla. 2ª: antes.
  return closest((a, n) => (n.start >= a ? n.start - a : -1)) ?? closest((a, n) => a - n.end)
}

// ── Detección de la respuesta segura (fallback) ─────────────────────────────
//
// "Fallback" = el texto del modelo se descartó entero y se sustituyó por una
// respuesta enlatada segura. Hoy hay dos fuentes:
//
//   1. `SAFE_RESPONSE` de output-validator.ts — cuando, tras borrar las oraciones
//      infractoras, no queda sustancia. NO se exporta: se detecta por su primera
//      frase en cada idioma.
//   2. `safeAsk()` de policy.ts, vía `ensureSubstance` — cuando la respuesta no
//      contiene ninguna cifra real. Tampoco se exporta, pero SÍ se puede computar:
//      `ensureSubstance("", {lang, missing})` devuelve exactamente ese texto. Se
//      calcula en vez de copiarlo, así no se desincroniza con AG08.

const SAFE_RESPONSE_MARKERS: Record<Language, string> = {
  es: 'No puedo prometerte resultados de inversión',
  pt: 'Não posso prometer-te resultados de investimento',
  en: "I can't promise you investment returns",
}

function isFallback(text: string, lang: Language, missing: string[]): boolean {
  if (Object.values(SAFE_RESPONSE_MARKERS).some((m) => text.includes(m))) return true
  return text.trim() === ensureSubstance('', { lang, missing }).trim()
}

// ── Subconjunto profundo, para expectScenarioState ──────────────────────────

function subsetMatch(expected: unknown, actual: unknown, path: string, errs: string[]): void {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      errs.push(`${path}: esperaba objeto, encontré ${JSON.stringify(actual)}`)
      return
    }
    for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
      subsetMatch(v, (actual as Record<string, unknown>)[k], path ? `${path}.${k}` : k, errs)
    }
    return
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      errs.push(`${path}: esperaba array de ${expected.length}, encontré ${JSON.stringify(actual)}`)
      return
    }
    expected.forEach((v, i) => subsetMatch(v, actual[i], `${path}[${i}]`, errs))
    return
  }
  if (expected !== actual) {
    errs.push(`${path}: esperaba ${JSON.stringify(expected)}, encontré ${JSON.stringify(actual)}`)
  }
}

// ── Carga y templating de escenarios ────────────────────────────────────────

const SCENARIOS_DIR = resolve(process.cwd(), 'tests/scenarios')

function jsonEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1)
}

function selectProfile(sel: ProfileSelector): Assignment {
  const all = canonicalProfiles()
  const found = all.find(
    (p) =>
      (sel.index === undefined || p.index === sel.index) &&
      (sel.archetype === undefined || p.archetype === sel.archetype) &&
      (sel.country === undefined || p.country === sel.country),
  )
  if (!found) throw new Error(`Ningún perfil sintético casa con ${JSON.stringify(sel)}`)
  return found
}

/**
 * Sustituye los `{{token}}` en el TEXTO del JSON antes de parsearlo. Así un
 * `{{monthlyNet}}` puede aparecer tanto dentro de una cadena ("Gano {{monthlyNet}}
 * euros") como en posición de número ("ingreso": {{monthlyNet}}), y en ambos
 * casos el JSON resultante es válido.
 */
function applyTemplate(raw: string, vars: Record<string, string | number>): string {
  return raw.replace(/\{\{(\w+)\}\}/g, (_all, key: string) => {
    if (!(key in vars)) throw new Error(`Variable de plantilla desconocida: {{${key}}}`)
    const v = vars[key]
    return typeof v === 'number' ? String(v) : jsonEscape(v)
  })
}

function loadScenario(file: string): Scenario {
  const raw = readFileSync(resolve(SCENARIOS_DIR, file), 'utf8')

  // El selector de perfil se lee de una primera pasada sin plantilla: no puede
  // depender de variables (sería circular).
  const head = JSON.parse(raw.replace(/\{\{(\w+)\}\}/g, '0')) as Scenario
  if (!head.profile) return JSON.parse(raw) as Scenario

  const p = selectProfile(head.profile)
  const fin = derivedFinancials(p)
  const vars: Record<string, string | number> = {
    index: p.index,
    name: p.name,
    email: p.email,
    country: p.country,
    language: p.language,
    archetype: p.archetype,
    age: p.age,
    monthlyNet: fin.monthlyNet,
    gastosMes: fin.gastosMes,
    sobrante: fin.sobrante,
    sobranteAnual: fin.sobrante * 12,
  }
  return JSON.parse(applyTemplate(raw, vars)) as Scenario
}

// ── El pipeline de un turno (espejo de route.ts, pasos 5-9) ─────────────────

interface TurnOutcome {
  finalText: string
  blocked: boolean
  state: ScenarioState
  bloque: string
  valores: number[]
  conceptos: Record<string, number>
  missing: string[]
  lang: Language
}

async function modelResponse(
  turn: Turn,
  live: boolean,
  scenario: Scenario,
  bloque: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  profile: Assignment | undefined,
): Promise<string> {
  if (!live) return turn.fixtureResponse

  // Import perezoso: en modo fixture nunca se toca la SDK de OpenAI.
  const { callLLMWithHistory } = await import('../src/lib/llm')
  const { buildSystemPrompt } = await import('../src/lib/prompts/consigliere')

  const lang = detectLanguage(turn.user)
  const fin = profile ? derivedFinancials(profile) : undefined
  const base = buildSystemPrompt({
    nombre: profile?.name ?? 'Usuario',
    pais: profile?.country ?? 'ES',
    idioma: lang,
    icaScore: 50,
    ingresosMes: fin?.monthlyNet ?? 0,
    gastosMes: fin?.gastosMes ?? 0,
    fugas: [],
    metas: [],
  })
  const LANG_NAME: Record<Language, string> = { es: 'ES', pt: 'PT', en: 'EN' }
  const system =
    `${base}\n\nIDIOMA OBLIGATORIO: el usuario escribe en ${LANG_NAME[lang]}. ` +
    `Responde ÍNTEGRAMENTE en ese idioma.` +
    (bloque ? `\n\n${bloque}` : '')

  const res = await callLLMWithHistory([...history, { role: 'user', content: turn.user }], system, {
    maxTokens: 400,
  })
  return res.content
}

async function runTurn(
  scenario: Scenario,
  turn: Turn,
  prevState: Partial<ScenarioState>,
  live: boolean,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  profile: Assignment | undefined,
): Promise<TurnOutcome> {
  const userLang = detectLanguage(turn.user)

  // 1-3 · estado conversacional → contexto verificado (cadena de AG08)
  const delta = extractScenarioDelta(turn.user, userLang)
  const state = mergeScenario(prevState, delta)
  const verified = buildScenarioContext(state, turn.user)

  // 4 · el modelo (fixture o real)
  const response = await modelResponse(turn, live, scenario, verified.bloque, history, profile)

  // 5 · guardarraíl de cifras: valores exactos + conceptos semánticos
  const guardrail = await runGuardrail(turn.user, response, {
    mode: 'mvp',
    cifrasCalculadas: { valores: verified.valores, conceptos: verified.conceptos },
    idioma: userLang,
  })
  let finalText = guardrail.texto_final

  // 6-7 · validador de política + enforcement
  const validation = validateConsigliereOutput(finalText)
  finalText = validation.text
  finalText = enforceOutputPolicy(finalText, validation)

  // 8 · disclaimer solo si el producto sobrevivió al enforcement
  if (
    validation.suggestedDisclaimer &&
    mentionsSpecificProduct(finalText) &&
    !finalText.includes(validation.suggestedDisclaimer)
  ) {
    finalText = `${finalText}\n\n${validation.suggestedDisclaimer}`
  }

  // 9 · cierre delegativo
  finalText = rewriteDelegativeClosing(finalText, userLang)

  // 10 · sustancia: si no queda una cifra concreta, pide el dato que falta
  finalText = ensureSubstance(finalText, { lang: userLang, missing: state.missing })

  return {
    finalText,
    blocked: guardrail.bloqueado,
    state,
    bloque: verified.bloque,
    valores: verified.valores,
    conceptos: verified.conceptos,
    missing: state.missing,
    lang: userLang,
  }
}

// ── Asserts ─────────────────────────────────────────────────────────────────

function checkTurn(turn: Turn, out: TurnOutcome, live: boolean): string[] {
  const errs: string[] = []
  const text = out.finalText

  // En --live un modelo real no reproduce literales: `expectContains` se omite.
  if (!live) {
    for (const s of turn.expectContains ?? []) {
      if (!text.includes(s)) errs.push(`expectContains: falta ${JSON.stringify(s)}`)
    }
  }

  for (const s of turn.expectNotContains ?? []) {
    if (text.includes(s)) errs.push(`expectNotContains: aparece ${JSON.stringify(s)}`)
  }

  for (const [concept, exp] of Object.entries(turn.expectConcept ?? {})) {
    const tol = exp.tol ?? 1
    const got = conceptValue(text, concept)
    if (got === undefined) {
      errs.push(`expectConcept.${concept}: no encontré ninguna cifra asociada al concepto`)
    } else if (Math.abs(got - exp.value) > tol) {
      errs.push(`expectConcept.${concept}: esperaba ${exp.value} ±${tol}, encontré ${got}`)
    }
  }

  if (turn.expectFallback !== undefined) {
    const got = isFallback(text, out.lang, out.missing)
    if (got !== turn.expectFallback) {
      errs.push(`expectFallback: esperaba ${turn.expectFallback}, encontré ${got}`)
    }
  }

  if (turn.expectBlocked !== undefined && turn.expectBlocked !== out.blocked) {
    errs.push(`expectBlocked: esperaba ${turn.expectBlocked}, encontré ${out.blocked}`)
  }

  if (turn.expectScenarioState) {
    subsetMatch(turn.expectScenarioState, out.state as unknown, '', errs)
  }

  return errs
}

// ── Runner ──────────────────────────────────────────────────────────────────

const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

async function main() {
  const argv = process.argv.slice(2)
  const live = argv.includes('--live')
  const verbose = argv.includes('--verbose')
  const filterArg = argv.find((a) => a.startsWith('--filter='))
  const filter = filterArg ? filterArg.slice('--filter='.length) : undefined

  if (live) {
    // El prompt de la tanda nombra LLM_API_KEY; llm.ts lee OPENAI_API_KEY.
    if (!process.env.OPENAI_API_KEY && process.env.LLM_API_KEY) {
      process.env.OPENAI_API_KEY = process.env.LLM_API_KEY
    }
    if (!process.env.OPENAI_API_KEY) {
      console.error(`${RED}--live requiere LLM_API_KEY (u OPENAI_API_KEY) en el entorno.${RESET}`)
      process.exit(1)
    }
  }

  const files = readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .filter((f) => !filter || f.includes(filter))

  if (files.length === 0) {
    console.error(`${RED}No hay escenarios en ${SCENARIOS_DIR}${filter ? ` con filtro "${filter}"` : ''}.${RESET}`)
    process.exit(1)
  }

  console.log(`${BOLD}Harness de regresión conversacional — AG07${RESET}`)
  console.log(`  modo:      ${live ? 'LIVE (LLM real)' : 'FIXTURE (sin LLM, determinista)'}`)
  console.log(`  escenario: src/lib/calculator/scenario.ts + orchestrator.ts (AG08)`)
  console.log(`  ficheros:  ${files.length}\n`)

  let okTurns = 0
  let failTurns = 0
  const failedScenarios: string[] = []

  for (const file of files) {
    const scenario = loadScenario(file)
    const profile = scenario.profile ? selectProfile(scenario.profile) : undefined

    const header = `${BOLD}${scenario.name}${RESET} ${DIM}[${scenario.playbook} · ${scenario.language}]${RESET}`
    const subtitle = profile ? `${DIM}perfil #${profile.index} ${profile.name} (${profile.archetype}, ${profile.country})${RESET}` : ''
    console.log(`${header} ${subtitle}`)

    let state: Partial<ScenarioState> = {}
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
    let scenarioFailed = false

    for (const [i, turn] of scenario.turns.entries()) {
      const out = await runTurn(scenario, turn, state, live, history, profile)
      state = out.state
      history.push({ role: 'user', content: turn.user }, { role: 'assistant', content: out.finalText })

      const errs = checkTurn(turn, out, live)
      const n = `T${i + 1}`
      if (errs.length === 0) {
        okTurns++
        console.log(`  ${GREEN}✓${RESET} ${n} ${DIM}${turn.user.slice(0, 62)}${turn.user.length > 62 ? '…' : ''}${RESET}`)
      } else {
        failTurns++
        scenarioFailed = true
        console.log(`  ${RED}✗${RESET} ${n} ${DIM}${turn.user.slice(0, 62)}${turn.user.length > 62 ? '…' : ''}${RESET}`)
        for (const e of errs) console.log(`      ${RED}${e}${RESET}`)
        console.log(`      ${DIM}final: ${JSON.stringify(out.finalText)}${RESET}`)
        console.log(`      ${DIM}estado: ${JSON.stringify(out.state)}${RESET}`)
        console.log(`      ${DIM}valores: [${out.valores.join(', ')}] · conceptos: ${JSON.stringify(out.conceptos)}${RESET}`)
      }

      if (verbose && errs.length === 0) {
        console.log(`      ${DIM}final: ${JSON.stringify(out.finalText)}${RESET}`)
        console.log(`      ${DIM}valores: [${out.valores.join(', ')}] · conceptos: ${JSON.stringify(out.conceptos)}${RESET}`)
      }
    }

    if (scenarioFailed) failedScenarios.push(scenario.name)
    console.log('')
  }

  const total = okTurns + failTurns
  console.log('─'.repeat(72))
  if (failTurns === 0) {
    console.log(`${GREEN}${BOLD}✅ ${okTurns}/${total} turnos OK${RESET} · ${files.length} escenarios`)
  } else {
    console.log(`${RED}${BOLD}❌ ${failTurns}/${total} turnos fallaron${RESET} · escenarios: ${failedScenarios.join(', ')}`)
  }
  process.exit(failTurns === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Fallo no capturado del harness:', err)
  process.exit(1)
})
