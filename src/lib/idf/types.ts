/**
 * @module idf/types
 * Tipos públicos del motor IDF — Índice de Dominio Financiero.
 *
 * Fuente canónica de fórmulas: `FORMULAS_IDF_ICA.md` (pendiente de creación
 * en disco; mientras tanto el contrato canónico vive en
 * `supabase/migrations/008_idf_function.sql` y `src/lib/idf.ts`).
 *
 * Escala 0–100, 4 dimensiones ponderadas:
 *   · Progreso al objetivo (progresoMeta)        40%
 *   · Control de fugas    (controlFugas)         25%
 *   · Estabilidad base    (estabilidadBase)      20%
 *   · Velocidad de ahorro (velocidadAhorro)      15%
 *
 * Niveles: bronce(0–25) · plata(26–50) · oro(51–75) · diamante(76–100).
 */

/** Nivel cualitativo del IDF. Null cuando no se puede calcular el score. */
export type IDFLevel = 'bronce' | 'plata' | 'oro' | 'diamante';

/**
 * Desglose por dimensión. Cada componente es un score 0–100 antes de
 * ponderar, o `null` si no hay datos suficientes para esa dimensión.
 *
 * Convención: cuando no hay meta activa los cuatro componentes son `null`
 * para reflejar que el cálculo carece de ancla; ver
 * §IDF-0 "Precondición meta activa" en FORMULAS_IDF_ICA.md.
 */
export interface IDFComponents {
  progresoMeta: number | null;
  controlFugas: number | null;
  estabilidadBase: number | null;
  velocidadAhorro: number | null;
}

/**
 * Resultado completo de un cálculo IDF.
 *
 * @property score          0–100 ya ponderado y redondeado, o `null` si no hay meta.
 * @property level          Nivel cualitativo, o `null` si `score === null`.
 * @property components     Desglose por dimensión (cada uno 0–100 o `null`).
 * @property dataAvailable  Indica si hay datos reales (transacciones o baseline)
 *                          que respalden el cálculo. `false` con `score !== null`
 *                          significa progreso teórico (e.g. solo `baseline_data`).
 * @property computedAt     ISO 8601 UTC del momento del cálculo.
 * @property reason         Cuando `score === null`, código que explica por qué
 *                          (e.g. `'no_goal_declared'`).
 */
export interface IDFResult {
  score: number | null;
  level: IDFLevel | null;
  components: IDFComponents;
  dataAvailable: boolean;
  computedAt: string;
  reason?: string;
}
