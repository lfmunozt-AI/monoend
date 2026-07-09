/**
 * scripts/harness/scenario.ts
 *
 * Punto de entrada ÚNICO a la cadena de escenario. Prefiere la implementación
 * real de AG08 (`src/lib/calculator/scenario.ts`) y cae al shim provisional de
 * AG07 mientras esa tanda no esté en develop.
 *
 * El día que AG08 mergee, el harness empieza a probar SU código sin cambiar una
 * línea: basta con que el módulo exista y exporte las tres funciones. Cuando eso
 * ocurra, `scenario-provisional.ts` puede borrarse.
 *
 * La ruta se resuelve contra `process.cwd()` porque el harness se lanza siempre
 * desde la raíz del paquete (`npm run test:regression`).
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as provisional from './scenario-provisional'
import type { ScenarioDelta, ScenarioState, ScenarioContext } from './scenario-provisional'

export type { ScenarioDelta, ScenarioState, ScenarioContext, LoanScenario } from './scenario-provisional'

export interface ScenarioModule {
  extractScenarioDelta(message: string): ScenarioDelta
  mergeScenario(prev: ScenarioState, delta: ScenarioDelta): ScenarioState
  buildScenarioContext(state: ScenarioState): ScenarioContext
}

export type ScenarioSource = 'ag08' | 'provisional'

const AG08_MODULE = resolve(process.cwd(), 'src/lib/calculator/scenario.ts')

const REQUIRED = ['extractScenarioDelta', 'mergeScenario', 'buildScenarioContext'] as const

/**
 * Carga la cadena de escenario. Si el módulo de AG08 existe pero no exporta el
 * contrato completo, se avisa y se usa el provisional: es un fallo de
 * coordinación, no una razón para que el harness reviente.
 */
export async function loadScenarioModule(): Promise<{
  mod: ScenarioModule
  source: ScenarioSource
}> {
  if (existsSync(AG08_MODULE)) {
    const loaded = (await import(pathToFileURL(AG08_MODULE).href)) as Partial<ScenarioModule>
    const faltan = REQUIRED.filter((k) => typeof loaded[k] !== 'function')
    if (faltan.length === 0) {
      return { mod: loaded as ScenarioModule, source: 'ag08' }
    }
    console.warn(
      `⚠️  src/lib/calculator/scenario.ts existe pero no exporta: ${faltan.join(', ')}. ` +
        'Usando el shim provisional de AG07.',
    )
  }
  return { mod: provisional, source: 'provisional' }
}
