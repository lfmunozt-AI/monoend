/**
 * scripts/enforcement-cases.ts — AG08
 *
 * Simula los TRES CASOS REALES del diagnóstico forense (telemetría de 27 turnos,
 * 13 con el texto modificado por nuestras capas) a través de la cadena completa
 * de enforcement, en los dos modos, e imprime ANTES / DESPUÉS.
 *
 * No es un test (no falla ni bloquea nada): es la evidencia reproducible que
 * acompaña al reporte de la tanda. Los asserts equivalentes viven en
 * `src/lib/guardrail/enforcement.test.ts`.
 *
 * Uso: npm run cases:enforcement
 */

import { applyEnforcement, type EnforcementInput, type EnforcementMode } from '../src/lib/guardrail'

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

// Estado real del turno 21:03:40 — el motor lo sabía TODO y scenario_missing
// estaba VACÍO: ingreso 2300, gastos 1750, sobrante 550, cuota 248,85,
// plazo 48, TAE 9.
const CONCEPTOS_COMPLETOS = {
  ingreso: 2300,
  gastos: 1750,
  sobrante: 550,
  cuota: 248.85,
  plazo: 48,
  tae: 9,
}

interface Caso {
  id: string
  hora: string
  titulo: string
  raw: string
  antes: string
  input: Omit<EnforcementInput, 'enforcement'>
}

const CASOS: Caso[] = [
  {
    id: 'A',
    hora: '21:03:40',
    titulo: 'confirmación natural sustituida por una plantilla que pedía datos ya conocidos',
    raw:
      'Movimiento registrado. Mantén el control de tus gastos y la disciplina en el pago mensual. ' +
      'En 30 días revisamos el avance y ajustamos si hace falta. ' +
      '¿Quieres que te prepare un recordatorio mensual para la cuota?',
    antes:
      'Para darte una cifra exacta necesito un dato concreto — ¿me compartes tus ingresos y gastos mensuales?',
    input: {
      userMessage: 'Registra el pago de este mes.',
      carril: 'FINANCIERO',
      lang: 'es',
      missing: [],
      valores: [2300, 1750, 550, 248.85, 48],
      conceptos: CONCEPTOS_COMPLETOS,
      esSimulacion: false,
    },
  },
  {
    id: 'B',
    hora: '20:55:55',
    titulo: 'digresión bien resuelta (el modelo responde y vuelve a la meta) sustituida por plantilla',
    raw: 'Hoy no puedo mirar el tiempo, pero sí tu plan. Volvamos a la meta: el siguiente hito es el pago de este mes.',
    antes:
      'Para darte una cifra exacta necesito un dato concreto — ¿me compartes tus ingresos y gastos mensuales?',
    input: {
      // OJO: "¿qué temperatura hace?" no trae señal financiera ni keyword META,
      // así que classifyTurn lo manda a FINANCIERO por CONTINUIDAD del
      // escenario — por eso ensureSubstance llegó a ejecutarse y lo destruyó.
      userMessage: '¿qué temperatura hace?',
      carril: 'FINANCIERO',
      lang: 'es',
      missing: [],
      valores: [2300, 1750, 550, 248.85, 48],
      conceptos: CONCEPTOS_COMPLETOS,
      esSimulacion: false,
    },
  },
  {
    id: 'C',
    hora: '21:02:58',
    titulo: 'nuestra capa fabricó un absurdo financiero: "3 meses de reserva" → "48 meses"',
    raw: 'Revisa tu Reserva de Imprevistos para asegurar que cubra al menos 3 meses de gastos.',
    antes: 'Revisa tu Reserva de Imprevistos para asegurar que cubra al menos 48 meses de gastos.',
    input: {
      userMessage: '¿Y la reserva cómo la dejo?',
      carril: 'FINANCIERO',
      lang: 'es',
      missing: [],
      valores: [2300, 1750, 550, 248.85, 48],
      conceptos: CONCEPTOS_COMPLETOS,
      esSimulacion: false,
    },
  },
]

async function main() {
  console.log(`${BOLD}Casos reales del diagnóstico forense — antes / después, por modo${RESET}`)
  console.log(`${DIM}Principio: los guardarraíles BLOQUEAN lo falso. NUNCA sustituyen lo bueno.${RESET}\n`)

  for (const caso of CASOS) {
    console.log(`${BOLD}CASO ${caso.id}${RESET} ${DIM}(${caso.hora}) — ${caso.titulo}${RESET}`)
    console.log(`  ${DIM}raw del modelo:${RESET} ${caso.raw}`)
    console.log(`  ${RED}ANTES (producción, full):${RESET} ${caso.antes}`)

    for (const enforcement of ['full', 'minimal'] as EnforcementMode[]) {
      const r = await applyEnforcement(caso.raw, { ...caso.input, enforcement })
      const intacto = r.texto === caso.raw
      const marca = intacto ? `${GREEN}INTACTO${RESET}` : `${YELLOW}MODIFICADO${RESET}`
      console.log(`  ${GREEN}DESPUÉS (${enforcement}):${RESET} ${r.texto || '(vacío)'}`)
      console.log(
        `    ${DIM}${marca}${DIM} · mutaciones: ${r.mutations.length}` +
        `${r.mutations.length ? ` [${r.mutations.map((m) => `${m.capa}:${m.regla}`).join(', ')}]` : ''}` +
        ` · mandamientos: ${r.violaciones.length}${RESET}`,
      )
    }
    console.log('')
  }
}

main().catch((err) => {
  console.error('Fallo no capturado:', err)
  process.exit(1)
})
