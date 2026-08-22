// SCENARIO STATE — el motor recuerda entre turnos.
//
// Causa raíz (QA): el motor era stateless (solo veía el último mensaje), así que
// "el banco me ofrece un 9%" no recalculaba nada — no había crédito en contexto
// que actualizar. Este módulo acumula el escenario financiero del diálogo y se
// persiste en conversations.scenario_state (migración 010).
//
// Extracción CONSERVADORA: solo señales de alta confianza. Lo ambiguo NO se
// extrae — mejor no tocar el estado que corromperlo. Código PURO, edge-safe.

import { parseDigitAmount, findNumberMentions, dedupeOverlaps, type NumberMention } from "../guardrail/numbers";
import { parseExpenseList, parseExpenseListDetallado, classifyExpenses, classifyExpense, type ItemSospechoso, type Rango } from "./expenses";
import type { Language } from "../language";
import { tieneSenalFinanciera, type Carril } from "../guardrail/turn-classifier";

export interface GastosDetalle {
  vitales: number;
  noVitales: number;
  desconocidos: number;
}

/**
 * PIEZA 5 (8ª tanda) — evidencia INDIVIDUAL de cada partida de gasto, para no
 * perder la trazabilidad que `gastos_detalle` (solo totales por grupo) no
 * conserva. Se AÑADE, no sustituye: `gastos_detalle` sigue existiendo con la
 * misma forma porque el orquestador y la calculadora lo consumen tal cual.
 * Flujo correcto: items → clasificación → buckets (nunca al revés).
 */
export interface GastoItemEntry {
  name: string;
  amount: number;
  category: "vital" | "no_vital" | "desconocido";
  /** De dónde vino este ítem este turno: regex determinista o tool_call del LLM. */
  source: "regex" | "tool";
  /** Turno (1-indexado) en el que se aportó, para poder auditar cuándo se dijo qué. */
  turn: number;
  /**
   * BLOQUEANTE 5b (QA testdev8) — este ítem fue REEMPLAZADO por uno posterior
   * con el mismo nombre normalizado (el más reciente gana). Se ARCHIVA, nunca
   * se borra — `gastos_items` sigue siendo el log completo (PIEZA 5, 8ª
   * tanda); `itemsGastoActivos` filtra los vigentes para cálculo/clasificación.
   */
  superseded?: boolean;
}

/**
 * PIEZA 1 (8ª tanda) — honestidad del extractor sobre su propia confianza.
 * NUNCA degrada globalmente: la afectación es SIEMPRE por campo (ver
 * `notaExtraccionAmbigua`/`deltaSinGastosPorDiscrepancia` — huérfanos y
 * discrepancias ya solo tocan el campo implicado, no el turno entero).
 *   COMPLETE   — todo número relevante quedó asignado, 0 huérfanos relevantes.
 *   PARTIAL    — hay campos extraídos con confianza Y huérfanos relevantes sin
 *                asignar. Los campos extraídos SÍ se usan (V1); se pregunta
 *                por los huérfanos citándolos.
 *   AMBIGUOUS  — un número podría ir a ≥2 campos, o hay un ítem sospechoso de
 *                pegado. El campo afectado no se cierra sin confirmar — pero
 *                en una lista de gastos, con una lectura estructural
 *                plausible, el ítem SÍ se usa (mismo principio V1, aplicado a
 *                nivel de partida): el eco solo pregunta.
 *   INVALID    — valor imposible (cero de placeholder, negativo). Ese campo
 *                queda MISSING y se pregunta.
 */
export type ExtractionStatus = "COMPLETE" | "PARTIAL" | "AMBIGUOUS" | "INVALID";

/**
 * PIEZA 6 (8ª tanda) — confianza por campo. Ver `actualizarFactStatus`.
 * PIEZA 3 (12ª tanda, §2 del contrato) — +CONFLICT/ASSUMED: dos fuentes
 * fiables (agregado vs. desglose) discrepan materialmente, o se adoptó un
 * valor sin confirmar tras agotar los intentos de aclaración.
 */
export type FactStatus = "MISSING" | "PARSED" | "CONFIRMED" | "CONFLICT" | "ASSUMED";

/** PIEZA 3 (12ª tanda) — un valor y en qué turno se declaró (para comparar orígenes cross-turno). */
export interface FuenteValor {
  valor: number;
  turn: number;
  /**
   * BLOQUEANTE 2 (revisión AG01, tanda 2) — ¿la extracción del turno que
   * fijó este origen fue COMPLETE? Solo relevante para `gastos_detalle_origen`
   * (§6 exige "extracción del detalle COMPLETE" como precondición del
   * escape a ASSUMED). `undefined` en orígenes que no la necesitan
   * (`gastos_agregado_origen`) o en datos previos a esta corrección.
   */
  completa?: boolean;
}

/**
 * PIEZA 3 (12ª tanda, §2/§6) — conflicto ACTIVO entre el agregado declarado y
 * la suma del desglose, de cualquier turno (no solo el mismo mensaje — ese
 * era el alcance equivocado que esta tanda corrige: G1c exige
 * `reconcile(previousTruth, currentDelta)`, no `reconcile(delta)`).
 */
export interface ConflictoGastos {
  agregado: number;
  agregadoTurn: number;
  detalle: number;
  detalleTurn: number;
  /** detalle − agregado, CON signo. */
  diff: number;
  /** |diff| / agregado × 100. */
  diffPct: number;
  /** Peticiones de aclaración YA hechas sin que el usuario resolviera. */
  attempts: number;
  /** ¿La extracción del DESGLOSE fue COMPLETE cuando se creó el conflicto? Condición del escape (§6). */
  detalleCompleta: boolean;
}

/** PIEZA 3 (12ª tanda, §2) — un valor SUPERSEDED: se conserva, nunca se borra. */
export interface SupersededEntry {
  valor: number;
  motivo: string;
  turn: number;
}

export interface CreditoState {
  /**
   * FIX 1 (7ª tanda, testdev6) — CERO NO ES UN VALOR. `monto`/`plazo_meses`
   * eran `number` obligatorios, así que un crédito parcial (solo TAE, o solo
   * monto) se rellenaba con `0` de PLACEHOLDER para satisfacer el tipo. Ese
   * 0 no es "desconocido": es un valor FALSO que se colaba como si fuera
   * real — `buildScenarioContext` exigía `plazo_meses > 0` para exponer
   * siquiera el monto, así que un crédito con monto real pero plazo aún sin
   * declarar dejaba el monto invisible para el guardarraíl (bloqueo circular:
   * se borraba la propia pregunta que iba a conseguir el plazo). Ahora
   * ausente es `undefined`, nunca `0`.
   */
  monto?: number;
  plazo_meses?: number;
  /** TAE en %. Si `tae_es_referencia`, es el 7% supuesto, no el del usuario. */
  tae_pct?: number;
  tae_es_referencia: boolean;
  /** Objeto de compra detectado en el mensaje que creó el crédito ("carro", "casa"…). */
  objeto?: string;
}

export interface MetaState {
  titulo?: string;
  monto?: number;
  plazo_meses?: number;
}

// FIX C — anti-repetición: distancia de Levenshtein normalizada. Suficiente
// para textos del tamaño de una respuesta del chat (unos pocos cientos de
// caracteres) — el bug real eran 5 turnos con la respuesta prácticamente
// calcada, no una coincidencia parcial que exija algo más sofisticado.
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/** Similitud aproximada entre dos textos, 0 (nada en común) a 1 (idénticos). */
export function similitudTexto(a: string, b: string): number {
  const s1 = a.trim().toLowerCase();
  const s2 = b.trim().toLowerCase();
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  return 1 - levenshtein(s1, s2) / Math.max(s1.length, s2.length);
}

/**
 * ¿`actual` repite casi literalmente la respuesta ANTERIOR del asistente en la
 * misma conversación? QA real: el modelo prometía "¿quieres que te proyecte el
 * plan?" cinco turnos seguidos, prácticamente palabra por palabra. Umbral por
 * defecto 90% — texto distinto con la misma ESTRUCTURA (cifras que cambian de
 * un turno a otro) no cuenta como repetición.
 */
export function esRespuestaRepetida(actual: string, anterior: string | undefined, umbral = 0.9): boolean {
  if (!anterior) return false;
  return similitudTexto(actual, anterior) >= umbral;
}

/**
 * MAYOR (tono, QA testdev10) — ¿la respuesta ACTUAL abre con la MISMA
 * CONSTRUCCIÓN que la anterior del asistente, aunque las cifras cambien?
 * Caso real: "Reducir a la mitad el ocio liberaría 75 €, dejando una
 * capacidad de 375 €" se repitió 4 veces con cifras distintas cada vez —
 * `esRespuestaRepetida` (similitud de TEXTO CRUDO, umbral 90%) nunca dispara
 * porque los números cambian y bajan la similitud literal, pero el
 * ESQUELETO de la frase es idéntico.
 *
 * Comparación POR PALABRA, no por carácter: un ítem con nombre más largo o
 * más corto ("ocio" vs "transporte") desplaza el resto de la frase y hunde
 * la similitud de Levenshtein sobre una ventana de caracteres, aunque la
 * construcción sea idéntica palabra a palabra. Se normalizan los dígitos a
 * un placeholder y se compara, POSICIÓN A POSICIÓN, solo las primeras
 * `palabrasApertura` palabras — el resto de la respuesta puede, y debe,
 * variar libremente; esto solo detecta la muletilla de arranque.
 */
export function esEstructuraRepetida(
  actual: string,
  anterior: string | undefined,
  umbral = 0.7,
  palabrasApertura = 8,
): boolean {
  if (!anterior) return false;
  const palabras = (t: string) =>
    t.trim().toLowerCase().replace(/[\d.,]+/g, "#").split(/\s+/).filter(Boolean).slice(0, palabrasApertura);
  const p1 = palabras(actual);
  const p2 = palabras(anterior);
  const n = Math.min(p1.length, p2.length);
  if (n < 3) return false;
  let coincidencias = 0;
  for (let i = 0; i < n; i++) {
    if (p1[i] === p2[i]) coincidencias++;
  }
  return coincidencias / n >= umbral;
}

/**
 * MAYOR 7 (QA testdev8) — cuenta cuántos mensajes ANTERIORES del USUARIO en
 * esta conversación son casi idénticos (≥90%) al mensaje actual. Más fiable
 * que comparar la respuesta del asistente: "¿cuánto me queda al mes?" ×3
 * produjo R1/R2/R3 donde R1 y R3 eran idénticas pero R2 no — comparar cada
 * respuesta solo contra la INMEDIATA anterior (`esRespuestaRepetida`) nunca
 * detecta ese patrón, porque R3 se compara contra R2 (distinta). La pregunta
 * del usuario, en cambio, fue literalmente la misma las tres veces.
 */
export function contarRepeticionesMensajeUsuario(
  actual: string,
  anteriores: string[],
  umbral = 0.9,
): number {
  return anteriores.filter((m) => similitudTexto(actual, m) >= umbral).length;
}

/**
 * FIX C (QA real: 5 turnos idénticos) — la última respuesta cerró proponiendo
 * un plan concreto ("¿quieres que te proyecte el plan?", "¿Confirmamos?"). Se
 * recuerda para que una confirmación corta del usuario ("sí") dispare la
 * EJECUCIÓN (PB7) en vez de que el modelo vuelva a diagnosticar desde cero.
 */
export interface PropuestaPendiente {
  /** Clasificación gruesa de la propuesta ("credito" | "meta" | "general"). */
  tipo: string;
  /** El cierre propuesto, tal cual se le mostró al usuario (para dar contexto). */
  resumen: string;
}

export interface ScenarioState {
  ingreso_mensual?: number;
  gastos_mensuales?: number;
  gastos_detalle?: GastosDetalle;
  /** true si `gastos_detalle` vino de una lista desglosada (defecto B). */
  gastos_es_detalle?: boolean;
  credito?: CreditoState;
  meta?: MetaState;
  /**
   * true si `meta` la puso el motor (derivada del crédito), no el usuario. Una
   * meta EXPLÍCITA del usuario siempre pisa la derivada y apaga este flag para
   * siempre: una vez el usuario habla, el motor deja de inventar.
   */
  meta_derivada?: boolean;
  /** FIX C — propuesta de plan aún sin confirmar por el usuario. */
  propuesta_pendiente?: PropuestaPendiente;
  /** FIX C — el usuario confirmó: PB7 debe ENTREGAR el plan, no re-diagnosticar. */
  plan_confirmado?: boolean;
  /**
   * PIEZA 6 — la meta activa se CERRÓ (el usuario confirmó el plan). Solo con
   * la meta cerrada puede iniciarse otra sin petición explícita.
   */
  meta_cerrada?: boolean;
  /**
   * PIEZA 6 — metas anteriores. Al abrir una meta nueva la anterior se ARCHIVA
   * aquí; nunca se borra.
   */
  goals_cerradas?: MetaState[];
  /**
   * PIEZA 6 — señal DEL TURNO (no se persiste): el usuario pidió explícitamente
   * cambiar, olvidar o sustituir la meta. Sin esta señal, ningún mensaje
   * ambiguo puede sobrescribir la meta activa.
   */
  meta_cambio_explicito?: boolean;
  /**
   * PIEZA 7 — turnos META consecutivos habiendo meta activa. Al llegar al
   * umbral se inyecta una nota de reconducción en el system prompt; cualquier
   * turno FINANCIERO lo reinicia. Nunca se corta al usuario en seco.
   */
  digresiones_seguidas?: number;
  /**
   * PIEZA 7 (6ª tanda) — ¿hay un agregado de gastos conocido? Derivado de
   * `gastos_mensuales !== undefined`, expuesto explícito para que el prompt no
   * tenga que inferirlo. El agregado BASTA para sobrante/capacidad/brecha —
   * nunca se vuelve a pedir el total si esto es true.
   */
  tiene_agregado_gastos?: boolean;
  /**
   * PIEZA 7 (6ª tanda) — ¿hay un desglose por partida conocido? Derivado de
   * `gastos_detalle !== undefined`. Solo hace falta para proponer un plan de
   * RECORTE (qué partida bajar y cuánto) — nunca para calcular viabilidad.
   */
  tiene_detalle_gastos?: boolean;
  /**
   * PIEZA 5 (8ª tanda) — evidencia acumulada de cada partida de gasto vista en
   * cualquier turno (se ACUMULA, nunca se pisa). `gastos_detalle` (buckets)
   * sigue siendo lo que consume el orquestador; esto es la traza de origen.
   */
  gastos_items?: GastoItemEntry[];
  /**
   * MENOR (follow-up QA testdev8, §8) — el contrato fija un cap de 5
   * versiones por campo en el estado persistido; `gastos_items` acumulaba sin
   * tope (§8 lo exige también aquí, no solo en `gastos_superseded`). Cuántas
   * versiones ANTIGUAS de una misma partida (por nombre normalizado) se
   * colapsaron al superar el cap — mismo patrón que
   * `gastos_superseded_colapsados`: nunca se borra el ACTIVO, solo el
   * historial más viejo cuando ya excede el tope.
   */
  gastos_items_colapsados?: number;
  /** PIEZA 1 (8ª tanda) — honestidad del último turno de extracción. No degrada nada por sí solo. */
  extraction_status?: ExtractionStatus;
  /** PIEZA 6 (8ª tanda) — confianza por campo (ver `FactStatus`). */
  factStatus?: Record<string, FactStatus>;
  /**
   * PIEZA 6 (8ª tanda) — campos que el ECO de este turno enunció, para que el
   * merge del turno SIGUIENTE sepa qué promover a CONFIRMED si el usuario no
   * lo corrige.
   */
  eco_pendiente?: { fields: string[] };
  /**
   * FIX 5 (9ª tanda) — el desglose de gastos entra como PARSED: el eco lo
   * enuncia pidiendo confirmación antes de usarse para PROPONER RECORTES POR
   * PARTIDA. Sobrante/capacidad/viabilidad de cuota/brecha NO dependen de
   * esto — el agregado basta y se responde con normalidad sin importar este
   * flag. Promoción: confirmación explícita del usuario, o el eco enunciado
   * sin corrección en el turno siguiente (ver `mergeScenario`).
   */
  detalle_confirmado?: boolean;
  /**
   * FIX 5 (9ª tanda) — señal DEL TURNO (no se persiste tal cual): el usuario
   * confirmó explícitamente el desglose pendiente ("sí, correcto"), o corrigió
   * una partida concreta. Se consume en `mergeScenario` y se descarta.
   */
  detalle_confirmado_explicito?: boolean;
  /**
   * FIX 5 (9ª tanda) — señal DEL TURNO: el usuario corrigió UNA partida
   * concreta del desglose ya conocido ("la luz son 150") sin repetir el
   * resto. `mergeScenario` sustituye SOLO ese ítem, conserva los demás.
   */
  gastos_item_correccion?: { name: string; amount: number };
  /**
   * PIEZA 3 (12ª tanda) — contador de turnos, incrementado en CADA merge
   * (haya o no dato nuevo). Es lo que permite fechar T1/T2/T3 para la
   * reconciliación cross-turno y el historial SUPERSEDED.
   */
  turn?: number;
  /** PIEZA 1 (12ª tanda, G1c) — último AGREGADO declarado explícitamente para gastos, con su turno. */
  gastos_agregado_origen?: FuenteValor;
  /** PIEZA 1 (12ª tanda, G1c) — último TOTAL derivado de un desglose de gastos, con su turno. */
  gastos_detalle_origen?: FuenteValor;
  /** PIEZA 3 (12ª tanda) — conflicto ACTIVO entre agregado y desglose de gastos, si lo hay. */
  gastos_conflict?: ConflictoGastos;
  /** PIEZA 3 (12ª tanda, §2/§6) — valor ASUMIDO tras escape (2 intentos), revocable y re-emergente (V6). */
  gastos_assumed?: { valor: number; fuente: "agregado" | "detalle"; turn: number };
  /**
   * PIEZA 3/5 (12ª tanda, §2/§8) — historial de valores perdedores de un
   * conflicto de gastos. Nunca se borra (V7); cap de 5 (§8) — lo anterior se
   * colapsa a `gastos_superseded_colapsados`.
   */
  gastos_superseded?: SupersededEntry[];
  /** PIEZA 5 (12ª tanda, §8) — cuántas entradas de `gastos_superseded` se colapsaron al llegar al cap. */
  gastos_superseded_colapsados?: number;
  /**
   * PIEZA 3 (12ª tanda) — señal DEL TURNO (no se persiste): el usuario
   * resolvió explícitamente un conflicto de gastos activo ("usa 2250", "eran
   * 2250", "el correcto es el desglose"). Se consume en `mergeScenario`.
   */
  gastos_resolucion?: { tipo: "agregado" | "detalle"; valorConfirmado: number };
  /**
   * PIEZA 3 (12ª tanda) — señal DEL TURNO: el usuario confirmó explícitamente
   * un valor ASSUMED ("sí, correcto" tras la declaración de supuesto).
   */
  gastos_assumed_confirmado?: boolean;
  /** Qué falta para completar el playbook activo. Recalculado en cada merge. */
  missing: string[];
}

// ── PARTICIÓN HECHOS / DIÁLOGO (13ª tanda — memoria a nivel de usuario) ──────
//
// DECISIÓN DE ARQUITECTURA (Luis, opción A): los HECHOS financieros son del
// USUARIO; el estado de DIÁLOGO es de la CONVERSACIÓN. Antes, TODO el
// `ScenarioState` vivía en `conversations.scenario_state`, así que cada
// conversación nueva arrancaba VACÍA: amnesia entre sesiones por diseño —
// contradice el ADN ("seguimiento constante") e incoherente con `goals`, que
// ya era por usuario. Un usuario del piloto que abre la app el día 2 espera
// que monoend recuerde su meta, su ingreso y su desglose.
//
// IMPORTANTE — la FORMA de `ScenarioState` en memoria NO CAMBIA. Cambian solo
// el ORIGEN (dos lecturas que se fusionan) y el DESTINO (dos escrituras) de la
// persistencia. Todo aguas abajo (orquestador, validate, policy, commandments,
// expenses, harness) sigue recibiendo exactamente el mismo objeto.
//
// Las tres listas de abajo son la ÚNICA fuente de verdad de la partición. Si
// se añade un campo a `ScenarioState` y no se clasifica aquí,
// `splitScenarioState` LANZA — nunca asume un lado por defecto. Esa es la
// garantía de que este bug (un hecho persistido en el lugar equivocado, o
// perdido) no puede reaparecer por omisión.

/** Campos del USUARIO: viajan entre conversaciones (`user_financial_state`). */
export const CAMPOS_HECHOS = [
  "ingreso_mensual",
  "gastos_mensuales",
  "gastos_detalle",
  "gastos_es_detalle",
  "gastos_items",
  "gastos_items_colapsados",
  "tiene_agregado_gastos",
  "tiene_detalle_gastos",
  "credito",
  "meta",
  "meta_derivada",
  "goals_cerradas",
  "extraction_status",
  "factStatus",
  "detalle_confirmado",
  // Ciclo de vida del conflicto (§2/§6/§8) — incluido `attempts` dentro de
  // `gastos_conflict`: los dos intentos previos al escape cuentan a nivel de
  // USUARIO, no se reinician al abrir un chat nuevo.
  "gastos_conflict",
  "gastos_assumed",
  "gastos_superseded",
  "gastos_superseded_colapsados",
  "gastos_agregado_origen",
  "gastos_detalle_origen",
  // `turn` es el RELOJ que fecha los hechos: los orígenes, el historial
  // SUPERSEDED y el conflicto guardan el turno en que ocurrieron. Si se
  // reiniciara al abrir una conversación nueva, esos turnos ya grabados
  // quedarían en el futuro y la auditoría dejaría de ser legible. Es un
  // hecho del usuario, no un contador de la conversación en curso.
  "turn",
] as const;

/** Campos de la CONVERSACIÓN: no viajan (`conversations.scenario_state`). */
export const CAMPOS_DIALOGO = [
  "propuesta_pendiente",
  "plan_confirmado",
  "meta_cerrada",
  "digresiones_seguidas",
  // El eco enunciado el turno anterior pertenece a ESTA conversación: es lo
  // que se dijo aquí, y solo aquí puede promoverse a CONFIRMED.
  "eco_pendiente",
  // Derivado: `mergeScenario` lo recalcula entero en cada turno
  // (`computeMissing`). Se clasifica aquí porque no es un hecho aportado por
  // el usuario, y así nunca viaja como si lo fuera.
  "missing",
] as const;

/**
 * Señales DEL TURNO: `mergeScenario` ya las borra antes de persistir, así que
 * en la práctica nunca llegan aquí. Se declaran igualmente para que la guarda
 * de campo desconocido no las confunda con un campo sin clasificar — y se
 * descartan explícitamente, sin ir a ninguno de los dos lados.
 */
export const CAMPOS_TRANSITORIOS = [
  "meta_cambio_explicito",
  "detalle_confirmado_explicito",
  "gastos_item_correccion",
  "gastos_resolucion",
  "gastos_assumed_confirmado",
] as const;

export interface ScenarioStateSplit {
  hechos: Partial<ScenarioState>;
  dialogo: Partial<ScenarioState>;
}

/**
 * Parte un `ScenarioState` en sus dos mitades persistibles. PURA: no muta la
 * entrada, no escribe nada.
 *
 * LANZA si encuentra un campo que no está en ninguna de las tres listas — es
 * deliberado: un campo nuevo sin clasificar es un bug de programación (se
 * persistiría en el lado equivocado o se perdería), y debe reventar en el
 * test, no degradarse en silencio en producción. El llamante en producción
 * (`persistTurn`) lo captura, lo registra como fallo crítico y deja que el
 * turno del usuario continúe.
 */
export function splitScenarioState(state: Partial<ScenarioState>): ScenarioStateSplit {
  const hechos: Record<string, unknown> = {};
  const dialogo: Record<string, unknown> = {};
  const sinClasificar: string[] = [];

  for (const [campo, valor] of Object.entries(state)) {
    if ((CAMPOS_HECHOS as readonly string[]).includes(campo)) hechos[campo] = valor;
    else if ((CAMPOS_DIALOGO as readonly string[]).includes(campo)) dialogo[campo] = valor;
    else if ((CAMPOS_TRANSITORIOS as readonly string[]).includes(campo)) continue;
    else sinClasificar.push(campo);
  }

  if (sinClasificar.length > 0) {
    throw new Error(
      `splitScenarioState: campo(s) sin clasificar en la partición hechos/diálogo: ${sinClasificar.join(", ")}. ` +
        "Añádelo(s) a CAMPOS_HECHOS, CAMPOS_DIALOGO o CAMPOS_TRANSITORIOS en scenario.ts — " +
        "nunca se asume un lado por defecto.",
    );
  }

  return { hechos: hechos as Partial<ScenarioState>, dialogo: dialogo as Partial<ScenarioState> };
}

/**
 * Reconstruye el `ScenarioState` que ve el pipeline a partir de sus dos
 * orígenes. La FORMA resultante es idéntica a la de antes de esta tanda —
 * nadie aguas abajo nota la diferencia.
 *
 * Los hechos mandan sobre lo que quede en el estado de la conversación: si
 * `user_financial_state` aún no tiene fila (usuario nuevo, o backfill parcial),
 * el estado de la conversación actúa de respaldo y se promueve a hechos en la
 * primera escritura — nunca se arranca vacío habiendo datos.
 */
export function mergeEstadoPersistido(
  hechos: Partial<ScenarioState> | undefined,
  dialogo: Partial<ScenarioState> | undefined,
): Partial<ScenarioState> {
  const base = { ...(dialogo ?? {}) };
  for (const [campo, valor] of Object.entries(hechos ?? {})) {
    if (valor !== undefined) (base as Record<string, unknown>)[campo] = valor;
  }
  return base;
}

// ── Normalización ────────────────────────────────────────────────────────────
function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// ── Patrones de extracción (alta confianza) ──────────────────────────────────

// Tasa: un porcentaje en CONTEXTO de tipo de interés / oferta bancaria.
const RATE_CONTEXT = /(tae|tasa|tipo|juros|interes|interest|apr|banco|ofrec|oferec|offer)/;
const PERCENT = /(\d[\d.,]*)\s*%/;

// El mensaje ENTERO es esencialmente un porcentaje (respuesta directa a la
// pregunta por la tasa). Cubre "18%", "es un 9", "de 9%", "9 por ciento",
// "9 percent", "it's 9". Anclado a ^…$ para exigir que no haya otras señales.
const BARE_RATE =
  /^\s*(?:es\s+un\s+|es\s+|un\s+|de\s+|it'?s\s+|the\s+rate\s+is\s+)?(\d[\d.,]*)\s*(?:%|por\s*ciento|por\s*cento|percent)?\s*\.?\s*$/i;

// Plazo en meses o años.
const PLAZO = /(\d[\d.,]*)\s*(a[ñn]os?|anos?|years?|meses|mes|months?)\b/;

// Monto con contexto de ingreso / gasto / precio.
const INGRESO_CTX = /\b(gano|ingreso|ingresos|sueldo|salario|cobro|rendimento|income|earn|salary)\b/;
// CORRECCIÓN (revisión AG01, tanda 2) — "gasté" normaliza (NFD, sin acentos)
// a "gaste": no lo cubría ninguna de las dos formas ("gasto"/"gastos" en
// GASTO_AGREGADO_DETALLE_RE, "gasto|gastos|gasta" aquí). Sin esa cobertura,
// "gasté 1800: renta 900..." no activaba NINGÚN patrón declarativo y caía
// entero en el parser de listas — "gasté" se emparejaba como NOMBRE de un
// ítem con 1800 de importe, y el agregado se sumaba una segunda vez al
// detalle (BLOQUEANTE 1, doble conteo). "gastó" ya normalizaba a "gasto" (la
// tilde de la 'ó' se elimina igual) y no necesitaba cambio.
// BLOQUEANTE A (V16, 13ª tanda) — formas verbales de PLURAL/1ª persona del
// plural ("gastamos 950 al mes", "gastaron", "gastábamos") tampoco estaban
// cubiertas: sin keyword reconocida, el mensaje entero caía al parser de
// listas y el agregado se contaba DOS veces (ver GASTO_AGREGADO_DETALLE_RE).
// BLOQUEANTE M1 (follow-up QA testdev8) — "gastado"/"gastada" (participio,
// "he gastado 900 en total: …") faltaba: ninguna otra forma de la lista lo
// cubre y es tan natural como "gasté"/"gastamos". Sin esto, la keyword no se
// reconocía y el mensaje entero caía al parser de listas sin fronteras.
const GASTO_CTX = /\b(gasto|gastos|gasta|gaste|gastado|gastada|gastamos|gastaron|gastabamos|despesas?|gastamo?s|spend|spent|expenses?)\b/;
// PIEZA 2 — total agregado seguido de ":" y un desglose ("gasto 1000: 500
// arriendo..."). El ":" es el marcador INEQUÍVOCO que distingue "aquí va un
// total, y luego el detalle" de "gasto= 1000 arriendo..." (sin ":", que es
// directamente el primer ítem del detalle, sin agregado propio — caso A).
// PIEZA 6 (12ª tanda, V15) — "gasto 1500 EN TOTAL: casa 700, comida 300" no
// matcheaba (el ":" no venía INMEDIATAMENTE tras el número) — el "1500" caía
// al camino de "gastoDeclaradoSimple", cuyo número (huérfano tras el
// encabezado "en total:") terminaba mal atribuido al primer ítem de la lista
// ("casa" se quedaba con 1500 en vez de 700). Tolera el filler ES/PT/EN entre
// el número y los dos puntos, sin cambiar el caso ya soportado (sin filler).
// "gaste" (forma normalizada de "gasté", ver GASTO_CTX arriba) cubre el
// pretérito de primera persona en la forma "agregado: detalle" también.
// BLOQUEANTE A (V16, 13ª tanda) — LA VENTANA ERA DEMASIADO ESTRECHA. El
// patrón exigía que la keyword y la cifra fueran prácticamente ADYACENTES
// (solo toleraba ":"/"=" y espacios). Con palabras intermedias —
// "mis gastos FUERON 1200: internet 300…", "gastamos 950 AL MES: mercado
// 500…" — no matcheaba NADA: el agregado no se reclamaba, su rango no se
// excluía, y el parser de listas se quedaba la cifra como un ítem más
// ("fueron"=1200, "gastamos"=950) que además se SUMABA al resto del
// desglose. El usuario decía 1.200 € y el sistema registraba 2.400 €, en
// silencio, sin huérfano, sin conflicto y con extraction_status COMPLETE.
//
// `CONECTOR_DECLARATIVO` enumera EXPLÍCITAMENTE lo que puede ir entre la
// keyword y la cifra (cópulas, marcadores de periodo y de aproximación, en
// ES/PT/EN). Deliberadamente NO es un comodín `.{0,N}`: un comodín se
// tragaría un nombre de partida real ("gastos: internet 300…" leería 300
// como agregado) y rompería V13/V15. Cada alternativa es una palabra
// funcional que jamás es el nombre de una partida.
const CONECTOR_DECLARATIVO =
  "(?:\\s+(?:" +
  // ES — cópulas y verbos de estado
  "fueron|fue|son|es|sera|seran|eran|era|andan|anda|rondan|ronda|alcanzan|alcanza|" +
  "ascienden\\s+a|asciende\\s+a|suman|suma|totalizan|totaliza|" +
  // ES — periodo y aproximación
  "al\\s+mes|por\\s+mes|mensuales?|mensualmente|en\\s+total|de\\s+media|" +
  "mas\\s+o\\s+menos|aproximadamente|aprox|cerca\\s+de|alrededor\\s+de|unos|unas|como|" +
  // PT
  "foram|foi|sao|e|serao|no\\s+total|por\\s+mes|mensais|cerca\\s+de|" +
  // EN
  "were|was|are|is|will\\s+be|about|around|roughly|approximately|" +
  "per\\s+month|monthly|in\\s+total|a\\s+month" +
  "))*";

// PIEZA 3 (8ª tanda) — misma convención de miles-con-espacio que el parser
// general (`guardrail/numbers.ts`, DIGIT_RE): "2 500" es 2500, no "2" seguido
// de un huérfano "500" (caso 10 — NO se toca la regla general, solo se hace
// que esta cifra la use también). La alternativa de espacio va PRIMERO
// (probada antes que el dígito llano) y exige grupos de EXACTAMENTE 3 dígitos.
//
// Definida ANTES de `GASTO_AGREGADO_DETALLE_RE` (movida aquí, BLOQUEANTE 5a,
// QA testdev8) — ese patrón necesita la MISMA captura consciente de espacio
// que esta constante ya resuelve; antes usaba `(\d[\d.,]*)` a pelo, que corta
// en el espacio y deja "2" en vez de "2200" (ver más abajo).
const AMOUNT = /(\d{1,3}(?: \d{3})+(?:,\d+)?|\d[\d.,]*)/;

// BLOQUEANTE 5a (QA testdev8) — "mis gastos fueron 2 200: arriendo 900,
// comida 500..." no matcheaba en absoluto: el grupo de captura del agregado
// era `(\d[\d.,]*)` (sin la alternativa de miles-con-espacio de `AMOUNT`), así
// que solo capturaba "2" y el resto del patrón ("200: arriendo...") ya no
// encajaba con `CONECTOR_DECLARATIVO + "\s*:"` — el regex entero fallaba y el
// mensaje caía al parser de listas, donde "fueron" se colaba como nombre de
// partida y "2"/"200" se separaban mal (ver STOPWORD_NAME_RE más abajo, y
// `esNombreValido`/`emparejarNombreMonto` en expenses.ts). Reutiliza
// `AMOUNT.source` para que el agregado declarado ("2 200") se lea como 2200
// igual que cualquier otro monto del sistema.
const GASTO_AGREGADO_DETALLE_RE = new RegExp(
  "\\b(?:gastos?|gaste|gastado|gastada|gastamos|gastaron|gastabamos|despesas?|expenses?|spent)\\b" +
    CONECTOR_DECLARATIVO +
    "\\s*[:=]?\\s*" + AMOUNT.source +
    CONECTOR_DECLARATIVO +
    "\\s*:",
);

// BLOQUEANTE M1 (revisión adversarial, follow-up QA testdev8) — REGLA
// ESTRUCTURAL DEL AGREGADO. `GASTO_AGREGADO_DETALLE_RE` enumera conectores
// (`CONECTOR_DECLARATIVO`): cualquier fraseo natural fuera de esa lista rompe
// el match. Caso real medido: "mis gastos del mes pasado fueron de 1500:
// hipoteca 800, comida 400, luz 300" no matchea ("del mes pasado" no está en
// la lista) — el mensaje cae al parser de listas, que lee "1500" como el
// importe de "hipoteca" (1500 en vez de 800) y el total sale 2200 en vez de
// 1500. Con usuarios reales, cualquier fraseo no anticipado es G1b.
//
// La señal estructural es más fuerte que enumerar palabras: una cifra
// seguida de ":" y, tras los dos puntos, una lista de ≥2 partidas con
// importe propio ES el agregado — sin importar qué palabras haya entre la
// keyword de gasto y la cifra, o entre la cifra y los dos puntos. El propio
// éxito del parseo de la lista es el validador (si lo que sigue a ":" no
// forma una lista real, esta función no se dispara). `CONECTOR_DECLARATIVO`/
// `GASTO_AGREGADO_DETALLE_RE` quedan como RESPALDO — el llamante los prueba
// después, no antes.
//
// FIX P1 (ronda 4, revisión adversarial) — la primera versión seguía
// exigiendo `GASTO_CTX.exec(n)` como ANCLA obligatoria antes de buscar el
// ":". Cualquier forma verbal fuera de esa lista cerrada (gerundio
// "gastando", participio compuesto, sinónimos nominales "desembolsos",
// "egresos", "salidas"…) hacía que la función devolviera `null` sin más,
// cayendo al parser de listas y duplicando el gasto real — el mismo defecto
// que esta regla existe para cerrar, solo que el punto único de fallo subió
// de "conector" a "keyword". Medido: "estoy gastando 1300 mensuales: renta
// 700, comida 400, transporte 200" → 2600 € `COMPLETE` (el doble, sin ninguna
// señal de duda).
//
// LA ESTRUCTURA ES EVIDENCIA SUFICIENTE POR SÍ SOLA — ninguna otra
// construcción del idioma tiene la forma "cifra + ':' + ≥2 partidas con
// importe propio". `GASTO_CTX` deja de ser requisito: si aparece en la
// misma cláusula, es refuerzo (confirma), pero su ausencia NUNCA bloquea la
// detección.
//
// BOUNDING — probado primero con `segmentSentences` (el segmentador
// numeric-safe del guardarraíl) y descartado: exige mayúscula tras el punto
// para reconocer un límite de frase, y texto real de usuario no la respeta
// ("vitales: alquiler 2000, seguro 1000, comida 2000. no vitales: ocio 3000,
// ropa 1000, gimnasio 2000" — la "n" minúscula de "no" hacía que las DOS
// mitades se leyeran como una sola frase, y el "2000" de "comida" se colaba
// como agregado de "no vitales:", duplicando el gasto — regresión real,
// atrapada por `test:regression`). `ultimoLimiteDeClausula` es más simple y
// deliberadamente NO exige mayúscula: cualquier ".", "!", "?", "," o ";" que
// no esté entre dígitos (no corta "1.200") cierra la cláusula anterior, sin
// importar qué letra siga.
//
// COMPUERTA 1 — LA COMA CORTA (follow-up, medición real). Sin la coma como
// frontera, "gano 2300, arriendo 900: comida 500, luz 120" leía el ÚLTIMO
// número de TODA la frase antes de ":" — es decir, alcanzaba hasta "900" SÍ,
// pero en mensajes más largos ("gano 2300: arriendo 900, comida 500" con un
// ":" pegado al ingreso) el candidato podía saltar por encima de una coma
// hacia un número de OTRA declaración por completo. La coma (y el punto y
// coma) ahora cierran la cláusula igual que el punto — "el candidato es la
// última cifra antes del ':' DENTRO DE SU PROPIA CLÁUSULA, no de toda la
// frase". Nunca cruza a una cláusula previa no relacionada ("Mi ingreso es
// 3000. Gastos: internet 300, agua 400." jamás debe leer 3000 como el
// agregado de gastos), y dentro de dos listas seguidas en el mismo mensaje
// ("vitales: ... . no vitales: ...") cada ":" solo ve su propia cláusula.
function ultimoLimiteDeClausula(text: string, hastaIdx: number): number {
  for (let i = hastaIdx - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "\n" || ch === "," || ch === ";") return i + 1;
    if (ch === "." || ch === "!" || ch === "?") {
      const antes = text[i - 1] ?? "";
      const despues = text[i + 1] ?? "";
      if (/\d/.test(antes) && /\d/.test(despues)) continue; // "1.200" — no corta.
      return i + 1;
    }
  }
  return 0;
}

// CAMBIO DE ENFOQUE (follow-up, tercer diseño) — el ancla léxica (keyword) y
// la posición sola (última cifra antes de ":") intentan deducir QUÉ ES una
// cifra por su CONTEXTO TEXTUAL, que tiene sinónimos infinitos. La
// aritmética no los tiene: es la validación estándar de extracción de
// facturas ("las partidas deben sumar al subtotal"). Compuerta 3 decide, no
// el contexto: |candidato − suma(items)| ≤ 5% (§6, MATERIALIDAD_MAX_PCT, el
// mismo umbral ya vigente — no se inventa otro) → el candidato ES el
// agregado (consistente, o en conflicto material — `reconciliarGastos` ya
// sabe resolver ambos con lo que esta función devuelve). Por encima del 5%,
// el candidato NO es un agregado: se descarta sin reclamar nada, y el
// mensaje entero cae al parser de listas — si el candidato tenía un nombre
// adyacente ("arriendo 900:"), se incorpora como una partida más (V19: no se
// pierde el dato, solo se reinterpreta).
function detectarAgregadoEstructural(
  message: string,
  n: string,
  rangosReclamados: ReadonlyArray<Rango>,
): { agregado: number; rango: Rango; restoDesdeColon: string } | null {
  const colonRe = /:/g;
  let colonMatch: RegExpExecArray | null;
  while ((colonMatch = colonRe.exec(n)) !== null) {
    const colonIdx = colonMatch.index;
    // COMPUERTA 1 — la cláusula que contiene el ":" acota dónde buscar la
    // cifra; ninguna keyword de gasto es requisito (`GASTO_CTX`, si aparece
    // en la cláusula, sería refuerzo — hoy ni se consulta: la estructura +
    // la aritmética ya bastan).
    const inicioClausula = ultimoLimiteDeClausula(n, colonIdx);
    // La cifra es el ÚLTIMO número entre el inicio de la cláusula y este
    // ":" — el más cercano al ":" es el candidato natural (duraciones/
    // plazos mencionados antes, "en los últimos 3 meses gasté 1200:",
    // quedan descartados por sí solos: "3" no es el último número del
    // tramo).
    const tramo = n.slice(inicioClausula, colonIdx);
    const numeroMatches = [...tramo.matchAll(new RegExp(AMOUNT.source, "g"))];
    if (numeroMatches.length === 0) continue;
    const ultimoMatch = numeroMatches[numeroMatches.length - 1];
    const agregado = parseDigitAmount(ultimoMatch[0]);
    if (!Number.isFinite(agregado) || agregado <= 0) continue;

    // COMPUERTA 2 — NO RECLAMADA (V13). Si otro patrón declarativo (ingreso,
    // crédito/plazo, meta) ya reclamó este rango de caracteres, esta cifra
    // NO es candidata a agregado de gastos — pertenece a ese otro campo, y
    // el resto del delta de ESTE mensaje se sigue extrayendo con normalidad
    // (V19: la ambigüedad del agregado nunca descarta lo demás).
    const candStart = inicioClausula + ultimoMatch.index;
    const candEnd = candStart + ultimoMatch[0].length;
    const yaReclamado = rangosReclamados.some((r) => candStart < r.end && r.start < candEnd);
    if (yaReclamado) continue;

    // Estructura confirmada SOLO si lo que sigue a ":" es una lista real de
    // ≥2 partidas — el propio parseo es el validador, no una suposición.
    const restoDesdeColon = message.slice(colonIdx + 1);
    const detailItems = parseExpenseList(restoDesdeColon);
    if (detailItems.length < 2) continue;

    // COMPUERTA 3 — RECONCILIACIÓN ARITMÉTICA. Por encima del umbral de
    // materialidad de §6, el candidato no es el agregado de ESTA lista —
    // ninguna reclamación, ningún doble conteo: `continue` prueba el
    // siguiente ":" (si lo hay), y si ninguno cierra, el llamante cae al
    // parser de listas sobre el mensaje completo, donde el candidato con
    // nombre adyacente se incorpora como una partida más.
    const suma = round2(detailItems.reduce((acc, i) => acc + i.amount, 0));
    const diffPct = suma !== 0 ? (Math.abs(agregado - suma) / suma) * 100 : Infinity;
    if (diffPct > MATERIALIDAD_MAX_PCT) continue;

    return { agregado, rango: { start: inicioClausula, end: colonIdx + 1 }, restoDesdeColon };
  }
  return null;
}

const PRECIO_CTX = /\b(precio|cuesta|vale|financiar|credito|prestamo|emprestimo|loan|financ|carro|coche|auto|casa|piso|vivienda)\b/;

// PIEZA 1 (5ª tanda) — MARCADOR ANUAL. "gano 27600 al año" NO es "gano 27600
// al mes": asumir mensual sin más es exactamente el tipo de suposición que el
// principio nuevo prohíbe ("ante ambigüedad se PREGUNTA, nunca se asume"). Si
// el número que INGRESO_CTX/GASTO_CTX capturarían trae este marcador
// PEGADO detrás, NO se asigna — queda sin asignar, y el detector de huérfanos
// (más abajo) lo atrapa para que el sistema pregunte en vez de dividir por 12
// en silencio.
const MARCADOR_ANUAL_RE =
  /^\s*(?:€\s*)?(?:al\s+a[ñn]o|anual(?:es)?|por\s+a[ñn]o|\/\s*a[ñn]o|per\s+year|\/\s*year|annually|yearly|ao\s+ano|por\s+ano|\/\s*ano)\b/;

/** ¿El número que empieza en `desdeIdx` (dentro de `n`) trae un marcador anual pegado? */
function esCifraAnual(n: string, ctxRe: RegExp, matchAmount: RegExpExecArray): boolean {
  const base = n.search(ctxRe);
  const after = n.slice(base + matchAmount.index + matchAmount[0].length, base + matchAmount.index + matchAmount[0].length + 20);
  return MARCADOR_ANUAL_RE.test(after);
}

// PIEZA 1 (6ª tanda) — RANGO. "gano entre 2000 y 2500" no tiene una cifra:
// tiene DOS candidatas. Elegir la primera que capture AMOUNT (2000) es
// justamente la suposición de baja confianza que el principio prohíbe — así
// se originó el bug de la tanda anterior (un campo "confiado" que en
// realidad era una adivinanza). Si el número capturado trae pegado un
// conector de rango ("y"/"a"/"o"/"-"/"hasta") seguido de OTRO número, NINGUNO
// de los dos se asigna: ambos quedan como huérfanos genuinos para que el
// detector (más abajo) pida cuál es el correcto.
const RANGO_AFTER_RE = /^\s*(?:-|y|o|a|to|or|hasta)\s*\d/;
// PIEZA 1 (8ª tanda) — caso 12: "gasto 2200 y 450" NO es un rango — es un
// agregado limpio (2200) seguido de un número suelto (450, huérfano
// genuino). Sin este marcador de apertura, CUALQUIER "número CONECTOR
// número" tras la keyword se leía como rango y descartaba AMBOS valores —
// incluido el agregado, que sí se sabe con confianza. Un rango real siempre
// se ABRE con "entre"/"desde"/"between" ("gano ENTRE 2000 y 2500"); sin esa
// apertura, la "y"/"o" que sigue es solo el resto de la frase.
const RANGO_ABRE_RE = /\b(?:entre|desde|between|from)\s*$/i;

/** ¿El número capturado es la primera mitad de un rango ("entre X y/a/o/- Y")? */
function esRango(n: string, ctxRe: RegExp, matchAmount: RegExpExecArray): boolean {
  const base = n.search(ctxRe);
  const matchStart = base + matchAmount.index;
  const after = n.slice(matchStart + matchAmount[0].length, matchStart + matchAmount[0].length + 20);
  const before = n.slice(Math.max(0, matchStart - 15), matchStart);
  return RANGO_AFTER_RE.test(after) && RANGO_ABRE_RE.test(before);
}

// Meta.
// BLOQUEANTE B (V15, 13ª tanda) — "quiero un piso de 200000" no matcheaba:
// META_CTX solo cubría "quiero COMPRAR/LLEGAR/AHORRAR", no "quiero + OBJETO"
// directo. Y el bloque de crédito tampoco lo recogía, porque exige monto Y
// plazo (aquí no hay plazo). Resultado: el 200000 quedaba HUÉRFANO — la ley
// de conservación (V14) garantizaba que no desapareciera en silencio, pero
// no que llegara a su campo correcto: eso es exactamente lo que V15
// (atribución) añade sobre V14 (conservación). El monto sí se conoce con
// confianza; lo que faltaba era el ancla contextual que lo llevara a `meta`.
const META_CTX =
  /\b(meta|objetivo|quiero (?:comprar|llegar|ahorrar)|quiero(?:mos)?\s+(?:un|una|el|la|unos|unas)?\s*(?:casa|piso|apartamento|apartamiento|vivienda|carro|coche|auto|vehiculo|moto)|goal|target|juntar|reunir)\b/;

// PIEZA 6 — PETICIÓN EXPLÍCITA de cambio de meta. Solo estas formas autorizan
// tocar la meta activa: "cambia la meta", "olvida el carro", "ahora quiero una
// casa". Una mención ambigua de otro objetivo NUNCA la sobrescribe.
const CAMBIO_META_EXPLICITO = new RegExp(
  "(" +
    // ES
    "cambia(?:r|me)?\\s+(?:la|mi|de)\\s+(?:meta|objetivo)|cambiar\\s+de\\s+(?:meta|objetivo)|" +
    "quiero\\s+cambiar\\s+(?:la|mi|de)\\s+(?:meta|objetivo)|olvida(?:te)?\\s+(?:el|la|lo|los|las|mi)\\b|" +
    "olvidemos|descarta\\s+(?:el|la|lo|mi)\\b|ya\\s+no\\s+quiero|ahora\\s+quiero|nueva\\s+meta|otra\\s+meta|mejor\\s+quiero|" +
    // PT
    "muda(?:r)?\\s+(?:a|de)\\s+(?:meta|objetivo)|esquece\\s+(?:o|a)\\b|ja\\s+nao\\s+quero|agora\\s+quero|nova\\s+meta|" +
    // EN
    "change\\s+(?:my|the)\\s+goal|forget\\s+(?:the|my)\\b|new\\s+goal|another\\s+goal|instead\\s+i\\s+want|i\\s+want\\s+to\\s+change" +
  ")",
);

/** ¿El usuario PIDE explícitamente cambiar/olvidar la meta activa? (PIEZA 6) */
export function pideCambioDeMeta(message: string): boolean {
  return CAMBIO_META_EXPLICITO.test(norm(message));
}

// Objeto de compra de un crédito (BUG 3): qué se está financiando. Se captura
// SOLO en el mensaje que crea el crédito (monto+plazo) para poder derivar una
// meta con título con sentido ("carro de 30000" → meta "carro") en vez de
// preguntar por una meta que el usuario ya dio, solo que sin la palabra "meta".
const OBJETO_CREDITO =
  /\b(carro|coche|auto|vehiculo|moto|casa|piso|apartamento|viatura|car|house|apartment|vehicle)\b/;

// FIX C — confirmación CORTA del usuario tras una propuesta ("sí", "ok",
// "dale", "arrancamos", "sim", "yes"…). Anclada a ^…$ (con puntuación/énfasis
// tolerado): un "sí" perdido dentro de una frase larga NO cuenta — el usuario
// tiene que estar respondiendo A la propuesta, no mencionando la palabra.
// MAYOR 1 (revisión AG01, tanda 2) — solo 3 de 8 frases naturales de
// confirmación funcionaban ("sí"/"vale"/"ok"); "sí, correcto"/"correcto"/
// "confirmo"/"exacto"/"así es" no. Un prefijo opcional ("sí,"/"sim,"/"yes,")
// delante del token principal cubre las formas compuestas ("sí, correcto")
// sin duplicar cada alternativa con y sin el "sí" — sigue ANCLADO a ^…$
// (nunca dispara sobre una mención suelta dentro de una frase larga).
const CONFIRMACION_CORTA_RE =
  /^(?:(?:si|s[ií]+|sim|yes)[,!.\s]+)?(si|s[ií]+|ok(?:ay)?|vale|dale|arrancamos|arranquemos|vamos|adelante|hagamoslo|confirmado|confirmo|correcto|correto|correct|confirmed|es correcto|e correto|is correct|exacto|exato|exactly|asi es|assim e|de acuerdo|sim|isso|vamos la|yes|yep|yeah|sure|deal|let'?s go|go ahead|sounds good|that'?s right|thats right)[!.\s]*$/;

/** ¿Es `message` una confirmación corta ("sí", "dale", "yes"…)? */
export function esConfirmacionCorta(message: string): boolean {
  return CONFIRMACION_CORTA_RE.test(norm(message).trim());
}

/** Convierte un plazo a meses. "3 años" → 36; "36 meses" → 36. */
function toMonths(value: number, unit: string): number {
  const u = norm(unit);
  if (/^(a[ñn]os?|anos?|years?)$/.test(u)) return Math.round(value * 12);
  return Math.round(value);
}

/**
 * PIEZA 5 (8ª tanda) — envuelve ítems ya parseados (por regex o por la tool
 * del LLM) como `GastoItemEntry` para este turno. `turn` queda en 0: es un
 * placeholder que `mergeScenario` SIEMPRE reescribe al acumular (necesita ver
 * el historial previo para saber qué turno toca).
 */
function itemsAGastoItemEntries(
  items: Array<{ name: string; amount: number }>,
  source: "regex" | "tool",
): GastoItemEntry[] {
  return items.map((i) => ({ name: i.name, amount: i.amount, category: classifyExpense(i.name), source, turn: 0 }));
}

/**
 * BLOQUEANTE 5b (QA testdev8) — el subconjunto VIGENTE de `gastos_items`: uno
 * por nombre normalizado, el más reciente (`superseded` los descarta). El log
 * completo nunca se toca (PIEZA 5, 8ª tanda: "se ACUMULA, nunca se pisa") —
 * esta es la vista que consume cualquier cálculo/clasificación/conteo
 * (`buildScenarioContext`, `tiene_detalle_gastos`, la corrección de un ítem,
 * el eco de "desglose sin confirmar"...).
 */
export function itemsGastoActivos(items: GastoItemEntry[] | undefined): GastoItemEntry[] {
  return (items ?? []).filter((i) => !i.superseded);
}

/**
 * ¿El mensaje tiene un plazo pegado a ":" + una lista real de ≥2 partidas
 * ("a 48 meses: cuota 900, seguro 50")? Devuelve los meses si sí, `null` si
 * no. Único punto de verdad para el patrón estructural "PLAZO BARE + LISTA",
 * usado en dos sitios que deben estar de acuerdo (`extractScenarioDelta`,
 * para decidir si el plazo completa un crédito, y `detectarNumerosHuerfanos`,
 * para registrar ese mismo plazo como huérfano relevante cuando no lo hace —
 * ver el FIX CRÉDITO FANTASMA en `extractScenarioDelta`).
 */
function plazoSueltoConLista(message: string): number | null {
  const n = norm(message);
  const plazoListaRe = new RegExp(PLAZO.source + "\\s*:");
  const plazoMatch = plazoListaRe.exec(n);
  if (!plazoMatch) return null;
  const restoTrasPlazo = message.slice(plazoMatch.index + plazoMatch[0].length);
  if (parseExpenseList(restoTrasPlazo).length < 2) return null;
  const meses = toMonths(parseDigitAmount(plazoMatch[1]), plazoMatch[2]);
  return meses > 0 ? meses : null;
}

/**
 * Extrae SOLO señales de alta confianza del mensaje. Devuelve un delta parcial;
 * lo ambiguo se omite. `lang` se acepta para futura afinación por idioma (hoy los
 * patrones ya cubren ES/PT/EN).
 */
export function extractScenarioDelta(
  message: string,
  lang: Language = "es",
  prev?: Partial<ScenarioState>,
): Partial<ScenarioState> {
  void lang; // los patrones ya cubren ES/PT/EN; el idioma queda para afinar a futuro
  const delta: Partial<ScenarioState> = {};
  const n = norm(message);

  // FIX V14 (11ª tanda) — FRONTERAS POSICIONALES. Un patrón declarativo
  // (gano/ingreso X, gasto X, crédito de X a N meses, TAE X%) reclama el
  // RANGO EXACTO de caracteres que consumió (no un valor ni una palabra
  // sueltos — ver `Rango` en expenses.ts). Un rango es preciso por
  // construcción: "casa" en la posición del crédito es frontera SOLO ahí;
  // "casa 700" a 30 caracteres de distancia sigue siendo una partida de
  // gasto válida. Reemplaza el reclamo por valor/palabra de la 10ª tanda
  // (`claimed`/`fronteraPalabras`), que convertía una palabra en una regla
  // GLOBAL — bug real: "casa" del crédito destruía TAMBIÉN "casa 700" en
  // otra parte del mensaje, sin relación con el crédito.
  const rangosReclamados: Rango[] = [];
  // FIX V15 (12ª tanda) — subconjunto de `rangosReclamados` SIN el rango del
  // CRÉDITO, usado solo para la exclusión de `meta.monto`. Un crédito
  // disparado por una palabra-objeto genérica ("casa", sin verbo de crédito
  // fuerte como "financiar"/"préstamo") y una meta EXPLÍCITA en la misma
  // frase ("mi meta son 200000 en 120 meses") legítimamente comparten el
  // mismo número — `mergeScenario` ya sabe reconciliar crédito↔meta (BUG 3).
  // Solo interesa bloquear el cruce con INGRESO/TAE/GASTO (el bug real:
  // "gano 2300, mi meta es una casa" no debe darle 2300 a la meta).
  const rangosParaMeta: Rango[] = [];

  // ── Tasa real (TAE) — porcentaje en contexto de interés/banco ─────────────
  if (RATE_CONTEXT.test(n)) {
    const rateMatch = RATE_CONTEXT.exec(n);
    const p = PERCENT.exec(n);
    if (rateMatch && p) {
      const tae = parseDigitAmount(p[1]);
      if (Number.isFinite(tae) && tae > 0 && tae < 100) {
        delta.credito = { tae_pct: tae, tae_es_referencia: false };
        const r1: Rango = { start: rateMatch.index, end: rateMatch.index + rateMatch[0].length };
        const r2: Rango = { start: p.index, end: p.index + p[0].length };
        rangosReclamados.push(r1, r2);
        rangosParaMeta.push(r1, r2);
      }
    }
  }

  // FIX 2 — respuesta CORTA de TAE. Si ya hay un crédito en el estado y el
  // mensaje es esencialmente un porcentaje ("18%", "es un 9", "9 por ciento",
  // "9 percent") sin otras señales → es la respuesta a "¿cuál es esa tasa?".
  if (!delta.credito?.tae_pct && prev?.credito) {
    const m = BARE_RATE.exec(n);
    if (m) {
      const tae = parseDigitAmount(m[1]);
      if (Number.isFinite(tae) && tae > 0 && tae < 100) {
        delta.credito = { tae_pct: tae, tae_es_referencia: false };
        const r: Rango = { start: m.index, end: m.index + m[0].length };
        rangosReclamados.push(r);
        rangosParaMeta.push(r);
      }
    }
  }

  // ── Crédito: monto + plazo ANCLADOS al contexto del crédito (defecto A) ────
  // El monto se busca DESDE la keyword de crédito/compra, no como primer número
  // global: en "gano 2500 ... carro de 30000 a 36 meses" el monto es 30000.
  //
  // INVESTIGADO Y REVERTIDO (follow-up, hueco verificado junto al de crédito
  // fantasma) — se probó relajar esto a "monto solo basta, plazo opcional"
  // para que "quiero un carro de 30000 con TAE 9%" atribuyera el monto a
  // `credito` en vez de a `meta`. Rompió 7 tests ya establecidos: `PRECIO_CTX`
  // matchea palabras sueltas ("carro", "casa", "piso") en CUALQUIER posición,
  // no solo en una declaración de compra — incluido como NOMBRE DE PARTIDA
  // dentro de una lista de gastos ("...servicios 250 carro 100 ropa"). El
  // requisito `plazo && amount` no era solo "el caso normal": era la red de
  // seguridad que evitaba que esa `carro`/`casa` genérica reclamara CUALQUIER
  // número cercano como si fuera un crédito. Revertido a su forma original;
  // el hueco queda confirmado y documentado (no corregido) — ver el informe
  // de esta tanda.
  if (PRECIO_CTX.test(n)) {
    const precioMatch = PRECIO_CTX.exec(n)!;
    const desdeCredito = n.slice(precioMatch.index).replace(PLAZO, " ");
    const plazo = PLAZO.exec(n);
    const amount = AMOUNT.exec(desdeCredito);
    if (plazo && amount) {
      const meses = toMonths(parseDigitAmount(plazo[1]), plazo[2]);
      const monto = parseDigitAmount(amount[1]);
      if (Number.isFinite(monto) && monto > 0 && meses > 0) {
        const objetoMatch = OBJETO_CREDITO.exec(n);
        delta.credito = {
          ...(delta.credito ?? { tae_es_referencia: true }),
          monto,
          plazo_meses: meses,
          ...(objetoMatch ? { objeto: objetoMatch[1] } : {}),
        };
        // Rango: desde la palabra de contexto ("casa"/"financiar"/…) hasta el
        // final de lo último que se haya consumido entre monto y plazo — cubre
        // TODA la frase declarativa ("casa de 200000 a 240 meses"), sea cual
        // sea el orden en que aparezcan monto/plazo dentro de ella.
        const amountAbsEnd = precioMatch.index + amount.index + amount[0].length;
        const plazoAbsEnd = plazo.index + plazo[0].length;
        rangosReclamados.push({ start: precioMatch.index, end: Math.max(amountAbsEnd, plazoAbsEnd) });
      }
    }
  }

  // PLAZO BARE + LISTA (follow-up, Compuerta 2 de la regla estructural de
  // gastos) — "a 48 meses: cuota 900, seguro 50" no tiene contexto de
  // crédito (`PRECIO_CTX` no matchea: sin "financiar"/"casa"/"préstamo"…)
  // pero SÍ declara un plazo justo antes de una lista. Sin reclamar su
  // rango, "48" queda disponible para que la regla estructural (o el parser
  // de listas de respaldo) lo confunda con el agregado o con el importe de
  // la primera partida ("cuota" = 48 €, absurdo). Se reclama SOLO cuando el
  // plazo está pegado a un ":" seguido de una lista REAL de ≥2 partidas —
  // nunca para una mención de duración suelta en cualquier otro punto de la
  // conversación (evita que "vuelvo en 3 meses" abra un crédito fantasma con
  // `missing: ['monto','tae']`).
  //
  // FIX CRÉDITO FANTASMA (follow-up) — el bloque de arriba reclamaba el rango
  // y escribía `delta.credito = {..., plazo_meses}` AUNQUE no existiera
  // ningún crédito real: "a 48 meses: cuota 900, seguro 50" no declara
  // monto, objeto ni TAE — es un plazo suelto pegado por casualidad a una
  // lista de gastos. Ese `credito` fantasma es un HECHO de usuario (persiste
  // entre turnos, y desde la migración de memoria continua, entre
  // sesiones), así que un plazo de un mensaje sin relación podía sobrevivir
  // y contaminar un crédito real declarado después (G1b — un mismo campo
  // nunca puede quedar poseído por dos declaraciones sin relación). El plazo
  // solo completa un crédito que YA EXISTE — con monto, en este mismo
  // mensaje (`delta.credito`, ver bloque anterior) o en el estado persistido
  // (`prev.credito`) — nunca crea uno desde cero. Si no hay crédito que
  // completar, el rango se reclama IGUAL (como frontera de cláusula, nunca
  // como campo) pero NO se escribe en `delta.credito`: "48" queda como
  // número huérfano relevante — `esCandidataFinanciera` excluye por diseño
  // todo número seguido de una unidad de tiempo, así que el huérfano NO cae
  // solo con dejarlo sin asignar; `detectarNumerosHuerfanos` lo registra a
  // propósito con `plazoSueltoConLista` (mismo patrón, ver más abajo) —
  // y `extraction_status` degrada a PARTIAL para que se pregunte a qué se
  // refiere, en vez de inventar un crédito que nadie pidió. Reclamar
  // el rango en ambos casos (haya o no crédito real) es necesario incluso
  // sin crédito: sin reclamarlo, el parser de listas de respaldo intenta
  // emparejar "48" como si fuera el importe de la primera partida ("cuota" =
  // 48 €, el mismo bug de "pendingAmount huérfano" ya corregido para Meta
  // en la tanda anterior — un nombre inválido antes del ":" ("a", "meses")
  // deja la cifra sin dueño, y el emparejador se la atribuye a la SIGUIENTE
  // palabra válida en vez de descartarla).
  if (!delta.credito?.plazo_meses) {
    const plazoListaRe = new RegExp(PLAZO.source + "\\s*:");
    const plazoMatch = plazoListaRe.exec(n);
    if (plazoMatch) {
      const restoTrasPlazo = message.slice(plazoMatch.index + plazoMatch[0].length);
      if (parseExpenseList(restoTrasPlazo).length >= 2) {
        const meses = toMonths(parseDigitAmount(plazoMatch[1]), plazoMatch[2]);
        if (meses > 0) {
          const r: Rango = { start: plazoMatch.index, end: plazoMatch.index + plazoMatch[0].length };
          const creditoYaExiste = (delta.credito?.monto ?? prev?.credito?.monto) !== undefined;
          if (creditoYaExiste) {
            delta.credito = { ...(delta.credito ?? { tae_es_referencia: true }), plazo_meses: meses };
            rangosParaMeta.push(r);
          }
          rangosReclamados.push(r);
        }
      }
    }
  }

  // ── Ingreso — anclado a su keyword ─────────────────────────────────────────
  if (INGRESO_CTX.test(n)) {
    const ingresoMatch = INGRESO_CTX.exec(n)!;
    const a = AMOUNT.exec(n.slice(ingresoMatch.index));
    // PIEZA 1 — "27600 al año" NO se asigna como si fuera mensual: el número
    // queda huérfano a propósito (ver MARCADOR_ANUAL_RE arriba). "entre 2000 y
    // 2500" tampoco se asigna: es un rango, no una cifra (ver esRango arriba).
    if (a && !esCifraAnual(n, INGRESO_CTX, a) && !esRango(n, INGRESO_CTX, a)) {
      const v = parseDigitAmount(a[1]);
      if (Number.isFinite(v) && v > 0) {
        delta.ingreso_mensual = v;
        // Rango: desde la palabra de ingreso ("gano"/"sueldo"/"salario"…)
        // hasta el final del propio número — cubre toda la frase declarativa.
        const amountAbsEnd = ingresoMatch.index + a.index + a[0].length;
        const r: Rango = { start: ingresoMatch.index, end: amountAbsEnd };
        rangosReclamados.push(r);
        rangosParaMeta.push(r);
      }
    }
  }

  // ── Meta ───────────────────────────────────────────────────────────────────
  // PIEZA 6 — la señal de cambio explícito viaja en el delta: es lo ÚNICO que
  // autoriza a `mergeScenario` a tocar una meta activa del usuario.
  //
  // REORDEN (follow-up, Compuerta 2 de la regla estructural de gastos) — Meta
  // se extrae ANTES que Gastos (antes iba después). "quiero una casa de
  // 150000: arriendo 900, comida 500" necesita que "150000" quede reclamado
  // por la Meta ANTES de que la regla estructural de gastos (o su respaldo,
  // el parser de listas) lo vea — si no, "150000" queda libre y el parser de
  // listas lo empareja con la primera partida ("arriendo" = 150000, absurdo,
  // y "900" queda huérfano). Los otros campos (TAE/crédito/ingreso/plazo
  // bare) ya reclaman ANTES de este bloque, así que Meta los sigue
  // respetando igual (`rangosParaMeta` ya los tiene).
  if (pideCambioDeMeta(message)) delta.meta_cambio_explicito = true;

  if (META_CTX.test(n)) {
    // FIX V15 (12ª tanda) — anclado a la keyword de meta, igual que
    // ingreso/gasto/crédito, y excluye números YA RECLAMADOS por otro campo
    // declarativo. Antes buscaba el PRIMER número de TODO el mensaje sin
    // ancla: "gano 2300, mi meta es una casa" capturaba el 2300 del ingreso
    // como si fuera el monto de la meta (V12/V13 — un número reclamado no
    // puede pertenecer a dos campos a la vez).
    const metaMatch = META_CTX.exec(n)!;
    const desdeMeta = n.slice(metaMatch.index);
    const plazo = PLAZO.exec(desdeMeta);
    const a = AMOUNT.exec(desdeMeta.replace(PLAZO, " "));
    const meta: MetaState = {};
    if (a) {
      const absStart = metaMatch.index + a.index;
      const absEnd = absStart + a[0].length;
      const yaReclamado = rangosParaMeta.some((r) => absStart < r.end && r.start < absEnd);
      if (!yaReclamado) {
        const v = parseDigitAmount(a[1]);
        if (Number.isFinite(v) && v > 0) {
          meta.monto = v;
          // Reclama también para GASTOS (V13/Compuerta 2): el monto de la
          // meta ("150000") no puede volver a leerse como agregado ni como
          // partida de una lista adyacente.
          rangosReclamados.push({ start: absStart, end: absEnd });
        }
      }
    }
    if (plazo) {
      // FIX 1 (7ª tanda) — cero no es un valor: un plazo mal formado (0 tras
      // redondear) no se persiste como si fuera real.
      const meses = toMonths(parseDigitAmount(plazo[1]), plazo[2]);
      if (meses > 0) meta.plazo_meses = meses;
    }
    if (meta.monto !== undefined || meta.plazo_meses !== undefined) delta.meta = meta;
  }

  // ── Gastos ──────────────────────────────────────────────────────────────────
  // PIEZA 2 (5ª tanda) — el usuario declara un TOTAL EXPLÍCITO (marcado con
  // ":") seguido de un desglose: "gasto 1000: 500 arriendo 250 carro 100
  // ropa". Se extraen AMBOS — agregado Y detalle — sin elegir uno en
  // silencio; la reconciliación (detectarDiscrepanciaGastos, más abajo) decide
  // si coinciden. Tiene PRIORIDAD sobre la lista: sin ella, el parser de listas
  // ya habría troceado el mensaje entero en detalle y el agregado nunca habría
  // quedado registrado aparte.
  // BLOQUEANTE M1 — la señal ESTRUCTURAL (cifra + ":" + lista real) es la
  // puerta principal; `GASTO_AGREGADO_DETALLE_RE` (conectores enumerados)
  // queda como respaldo para cuando no hay ":" o la lista no valida.
  const estructural = detectarAgregadoEstructural(message, n, rangosReclamados);
  const aggMatch = estructural ? null : GASTO_AGREGADO_DETALLE_RE.exec(n);
  if (estructural) {
    delta.gastos_mensuales = estructural.agregado;
    rangosReclamados.push(estructural.rango);
    rangosParaMeta.push(estructural.rango);
    const detailItems = parseExpenseList(estructural.restoDesdeColon);
    const cls = classifyExpenses(detailItems);
    delta.gastos_detalle = {
      vitales: cls.vitales.total,
      noVitales: cls.noVitales.total,
      desconocidos: cls.desconocidos.total,
    };
    delta.gastos_es_detalle = true;
    delta.gastos_items = itemsAGastoItemEntries(detailItems, "regex");
  } else if (aggMatch) {
    const agregado = parseDigitAmount(aggMatch[1]);
    if (Number.isFinite(agregado) && agregado > 0) {
      delta.gastos_mensuales = agregado;
      const r: Rango = { start: aggMatch.index, end: aggMatch.index + aggMatch[0].length };
      rangosReclamados.push(r);
      rangosParaMeta.push(r);
    }
    const restoDesdeColon = message.slice(aggMatch.index + aggMatch[0].length);
    const detailItems = parseExpenseList(restoDesdeColon);
    if (detailItems.length >= 2) {
      const cls = classifyExpenses(detailItems);
      delta.gastos_detalle = {
        vitales: cls.vitales.total,
        noVitales: cls.noVitales.total,
        desconocidos: cls.desconocidos.total,
      };
      delta.gastos_es_detalle = true;
      delta.gastos_items = itemsAGastoItemEntries(detailItems, "regex");
    }
  } else {
    // FIX 1/2b/3 (9ª tanda) + FIX V14-2 (11ª tanda, SIMETRÍA) — candidato de
    // valor declarativo de "gasto X" ("gasto aproximadamente 2000 entre..."
    // → 2000). El NÚMERO no se reclama a ciegas: primero se comprueba si, sin
    // reclamarlo, el mensaje YA forma una lista real de ≥2 pares. Esa prueba
    // distingue los dos casos reales que colisionan:
    //   · "gasto= 1000 arriendo 500 servicios 250..." — el "1000" no es un
    //     valor declarativo aislado, es la primera partida (arriendo=1000);
    //     SIN reclamarlo, el emparejador YA lo une a "arriendo" y encuentra
    //     4 pares — es una lista real, el NÚMERO nunca se reclama.
    //   · "gasto aproximadamente 2000 entre vivienda, comida, servicios,
    //     ocio" — SIN reclamar nada, el emparejador solo logra UN par
    //     espurio y comida/servicios/ocio quedan sin número propio — no hay
    //     evidencia de lista (<2 pares): el NÚMERO SÍ se reclama.
    // La PALABRA "gasto" es DISTINTA: SIEMPRE es frontera, sin condición —
    // igual que "gano"/"sueldo" en el bloque de ingreso (arriba). BUG
    // BLOQUEANTE (11ª tanda, revisión adversarial): la versión anterior solo
    // volvía frontera la palabra "gasto" DENTRO de la rama de reclamación del
    // número, así que "gano 2000 y gasto en arriendo 800, comida 300, luz
    // 100" (donde el candidato 800 SÍ resultaba ser parte de una lista, no
    // declarativo) dejaba "gasto" como palabra suelta — "y gasto en
    // arriendo" se validaba junto y NO_ES_GASTO lo rechazaba entero,
    // perdiendo el arriendo (800) en silencio.
    let gastoDeclaradoSimple: number | undefined;
    let gastoWordRango: Rango | undefined;
    let gastoAmountRango: Rango | undefined;
    if (GASTO_CTX.test(n)) {
      const gastoMatch = GASTO_CTX.exec(n)!;
      gastoWordRango = { start: gastoMatch.index, end: gastoMatch.index + gastoMatch[0].length };
      const a = AMOUNT.exec(n.slice(gastoMatch.index));
      if (a && !esCifraAnual(n, GASTO_CTX, a) && !esRango(n, GASTO_CTX, a)) {
        const v = parseDigitAmount(a[1]);
        if (Number.isFinite(v) && v > 0) {
          gastoDeclaradoSimple = v;
          const amountAbsStart = gastoMatch.index + a.index;
          gastoAmountRango = { start: amountAbsStart, end: amountAbsStart + a[0].length };
        }
      }
    }

    // Prueba probatoria: ¿ya hay lista real SIN reclamar el NÚMERO candidato?
    // (la PALABRA "gasto" sí entra aquí ya — es incondicional, ver arriba).
    const rangosProbatoria = gastoWordRango ? [...rangosReclamados, gastoWordRango] : rangosReclamados;
    let listResult = parseExpenseListDetallado(message, gastoDeclaradoSimple, rangosProbatoria);
    if (gastoDeclaradoSimple !== undefined && listResult.items.length < 2) {
      // Sin el número disponible para el emparejamiento espontáneo, NO
      // emergió ninguna lista real → es un valor declarativo genuino: se
      // reclama también su rango y se excluye de la lista final.
      if (gastoWordRango) { rangosReclamados.push(gastoWordRango); rangosParaMeta.push(gastoWordRango); }
      if (gastoAmountRango) { rangosReclamados.push(gastoAmountRango); rangosParaMeta.push(gastoAmountRango); }
      listResult = parseExpenseListDetallado(message, gastoDeclaradoSimple, rangosReclamados);
    } else {
      // Ya había ≥2 pares SIN reclamar el número — probablemente ES una de
      // las partidas (o es irrelevante). El número NO se reclama, pero la
      // PALABRA "gasto" SÍ queda como frontera permanente (simetría con
      // ingreso) — nunca debe colarse en el nombre de una partida.
      gastoDeclaradoSimple = undefined;
      if (gastoWordRango) { rangosReclamados.push(gastoWordRango); rangosParaMeta.push(gastoWordRango); }
      listResult = parseExpenseListDetallado(message, undefined, rangosReclamados);
    }
    const esListaReal = listResult.items.length >= 2;

    if (esListaReal) {
      const cls = classifyExpenses(listResult.items);
      delta.gastos_detalle = {
        vitales: cls.vitales.total,
        noVitales: cls.noVitales.total,
        desconocidos: cls.desconocidos.total,
      };
      delta.gastos_es_detalle = true;
      // PIEZA 5 (8ª tanda) — conserva cada partida individual (name, amount,
      // categoría), no solo los totales por grupo. Flujo: items → clasificación
      // → buckets (los buckets de arriba se derivan de los mismos ítems).
      delta.gastos_items = itemsAGastoItemEntries(listResult.items, "regex");
    } else if (gastoDeclaradoSimple !== undefined) {
      // FIX 3 (9ª tanda) — sin lista real, el agregado declarado MANDA. Nunca
      // se sustituye por un detalle parcial o inventado; `gastos_es_detalle`
      // queda sin tocar (no hay desglose que ofrecer).
      delta.gastos_mensuales = gastoDeclaradoSimple;
    }
  }

  // ── PIEZA 3 (12ª tanda, §2) — RESOLUCIÓN EXPLÍCITA de un conflicto de gastos ─
  // BLOQUEANTE 3 (revisión AG01, tanda 2) — se busca contra CONFLICT **o**
  // ASSUMED (V6: "revocable SIEMPRE", no solo mientras el conflicto sigue
  // vivo — `parConflictoParaResolucion` reconstruye el par desde los
  // orígenes cuando ya escapó a ASSUMED). Dos formas: por TIPO ("el correcto
  // es el desglose") o por VALOR (una cifra que coincide con uno de los dos
  // lados, tolerando ±1 € de redondeo).
  const parParaResolucion = parConflictoParaResolucion(prev);
  if (parParaResolucion) {
    const resolucion = detectarResolucionConflicto(message, parParaResolucion);
    if (resolucion) delta.gastos_resolucion = resolucion;
  }

  // PIEZA 3 (12ª tanda, V6) — confirmación explícita de un valor ASSUMED
  // ("sí, correcto" tras la declaración de supuesto — mismo patrón que la
  // confirmación del desglose, FIX 5 de la 9ª tanda).
  if (prev?.gastos_assumed && esConfirmacionCorta(message)) {
    delta.gastos_assumed_confirmado = true;
  }

  // ── FIX C — confirmación corta tras una propuesta pendiente ────────────────
  // "sí" SOLO dispara ejecución si había algo que confirmar; sobre un estado
  // sin propuesta pendiente es ruido conversacional ("sí, sigue así") y no
  // marca nada — evita falsos positivos de plan_confirmado.
  if (prev?.propuesta_pendiente && esConfirmacionCorta(message)) {
    delta.plan_confirmado = true;
  }

  // ── FIX 5 (9ª tanda) — confirmación/corrección del desglose pendiente ──────
  // Solo si el turno ANTERIOR ecoó un desglose sin confirmar todavía
  // (`eco_pendiente.fields` incluye 'gastos_detalle') y este turno NO trajo
  // uno nuevo (si trajera uno nuevo, `delta.gastos_es_detalle` ya lo reinicia
  // a PARSED en `mergeScenario` — no hay nada que confirmar/corregir aquí).
  const detalleEsperandoConfirmacion = !!prev?.eco_pendiente?.fields.includes("gastos_detalle") && !delta.gastos_es_detalle;
  if (detalleEsperandoConfirmacion) {
    if (esConfirmacionCorta(message)) {
      delta.detalle_confirmado_explicito = true;
    } else if (prev?.gastos_items) {
      const correccion = detectarCorreccionDeItem(message, itemsGastoActivos(prev.gastos_items));
      if (correccion) {
        delta.gastos_item_correccion = correccion;
        delta.detalle_confirmado_explicito = true;
      }
    }
  }

  // V16 (NUEVO, revisión AG01 tanda 2) — NINGÚN NÚMERO SE CUENTA DOS VECES.
  // Defensa en profundidad: aunque el fix primario (GASTO_CTX/
  // GASTO_AGREGADO_DETALLE_RE cubriendo "gaste") evita que el agregado se
  // cuele como ítem en el caso conocido, cualquier otra vía de extracción
  // futura podría repetir el mismo error. Si un ítem del desglose tiene
  // EXACTAMENTE el mismo importe que el agregado declarado EN ESTE MISMO
  // mensaje, es el propio agregado mal atribuido como partida — se descarta
  // como ítem fantasma y el detalle se recalcula sin él.
  const conGuardaV16 = aplicarGuardaV16(delta);

  const limpio = aplicarGuardaDeSanidad(conGuardaV16);

  // FIX V14-3 (11ª tanda, LEY DE CONSERVACIÓN) — extraction_status SIEMPRE
  // viene definido en el delta que devuelve esta función, nunca `undefined`.
  // Antes solo se calculaba en route.ts (vía `analizarExtraccion`, DESPUÉS de
  // llamar a esta función) — quien probara `extractScenarioDelta` de forma
  // aislada (como esta misma revisión) nunca veía el estado de honestidad de
  // la extracción. Se calcula aquí, con el delta YA limpio de la guarda de
  // sanidad, y route.ts sigue pudiendo recalcularlo/sobreescribirlo sin
  // problema (mismo resultado, redundante pero inofensivo).
  limpio.extraction_status = analizarExtraccion(message, limpio).extraction_status;

  return limpio;
}

// PIEZA FIX 5 — "la luz son 150": corrige UNA partida ya conocida sin
// reescribir el resto del desglose. Solo dispara si el nombre mencionado
// coincide con un ítem YA existente (`itemsPrevios`) — de lo contrario no es
// una corrección, es una frase cualquiera con un número.
const CORRECCION_ITEM_RE =
  /\b(?:la|el|los|las)?\s*([\p{L}][\p{L}_.-]*(?:\s+[\p{L}][\p{L}_.-]*){0,2})\s+(?:es|son|cuestan?|valen?)\s+(\d[\d.,]*)\b/iu;

export function detectarCorreccionDeItem(
  message: string,
  itemsPrevios: GastoItemEntry[],
): { name: string; amount: number } | null {
  if (itemsPrevios.length === 0) return null;
  const m = CORRECCION_ITEM_RE.exec(message);
  if (!m) return null;
  const amount = parseDigitAmount(m[2]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const nombreMencionado = norm(m[1].trim());
  const encontrado = itemsPrevios.find((i) => {
    const n2 = norm(i.name);
    return n2 === nombreMencionado || n2.includes(nombreMencionado) || nombreMencionado.includes(n2);
  });
  if (!encontrado) return null;
  return { name: encontrado.name, amount };
}

// ── PIEZA 3 (12ª tanda, §2) — RESOLUCIÓN EXPLÍCITA DE UN CONFLICTO ──────────
//
// "el modelo redacta, el sistema decide": esto es DETECCIÓN determinista de
// que el usuario resolvió — nunca genera la frase de respuesta. Dos formas:
//   · por TIPO: "el correcto es el desglose/total", "quédate con el total".
//   · por VALOR: una cifra que coincide (±1 € de redondeo) con uno de los dos
//     lados en conflicto — "usa 2250", "eran 2250", "me equivoqué, son 2250".
const RESOLUCION_TIPO_RE =
  /\b(?:el correcto es|correcto es|qu[eé]date con|usa(?:mos)?|toma(?:mos)?|usemos)\s+(?:el|la)?\s*(desglose|detalle|total|agregado)\b/i;
// BLOQUEANTE 3 (revisión AG01, tanda 2) — "no, son 2200" y "corrige: 2200"
// no estaban cubiertas (solo se detectaron al ejercitar la revocación de un
// ASSUMED, pero la cobertura de fraseo es la misma para un CONFLICT).
const RESOLUCION_VALOR_RE =
  /\b(?:usa|uso|usemos|usar|toma(?:mos)?|qu[eé]date con|el correcto es|son en realidad|en realidad son|me equivoqu[eé],?\s*son|eran|era|no,?\s*son|corrig[eo]:?|correccion:?)\s+(\d[\d.,]*)/i;

export interface ResolucionConflictoGastos {
  tipo: "agregado" | "detalle";
  valorConfirmado: number;
}

/**
 * ¿El mensaje resuelve explícitamente el conflicto de gastos ACTIVO?
 * `null` si no hay ninguna resolución reconocible — un mensaje ambiguo NUNCA
 * se interpreta como resolución (mejor preguntar de nuevo que asumir mal).
 */
export function detectarResolucionConflicto(
  message: string,
  conflict: ConflictoGastos,
): ResolucionConflictoGastos | null {
  const n = norm(message);
  const tipoMatch = RESOLUCION_TIPO_RE.exec(n);
  if (tipoMatch) {
    const tipo = tipoMatch[1];
    if (/^(?:desglose|detalle)$/.test(tipo)) return { tipo: "detalle", valorConfirmado: conflict.detalle };
    if (/^(?:total|agregado)$/.test(tipo)) return { tipo: "agregado", valorConfirmado: conflict.agregado };
  }
  const valorMatch = RESOLUCION_VALOR_RE.exec(n);
  if (valorMatch) {
    const v = parseDigitAmount(valorMatch[1]);
    if (Math.abs(v - conflict.detalle) <= 1) return { tipo: "detalle", valorConfirmado: conflict.detalle };
    if (Math.abs(v - conflict.agregado) <= 1) return { tipo: "agregado", valorConfirmado: conflict.agregado };
  }
  return null;
}

/**
 * BLOQUEANTE 3 (revisión AG01, tanda 2) — §6 dice "revocable SIEMPRE" (V6),
 * pero `detectarResolucionConflicto` solo se invocaba si `gastos_conflict`
 * seguía activo — una vez que el escape lo cerraba a `gastos_assumed`, NINGUNA
 * corrección del usuario tenía a qué referente engancharse ("en realidad son
 * 2200" caía en el vacío para siempre). Los orígenes (`gastos_agregado_origen`/
 * `gastos_detalle_origen`) SOBREVIVEN al escape — se fijan en la propia rama
 * de escape de `reconciliarGastos` — así que un ASSUMED siempre tiene de
 * dónde reconstruir el par agregado/detalle contra el que evaluar una
 * resolución. Devuelve el `gastos_conflict` real si lo hay; si no, un par
 * SINTÉTICO reconstruido desde el ASSUMED activo; `null` si no hay ninguno de
 * los dos (nada que resolver).
 */
export function parConflictoParaResolucion(prev: Partial<ScenarioState> | undefined): ConflictoGastos | null {
  if (prev?.gastos_conflict) return prev.gastos_conflict;
  if (prev?.gastos_assumed && prev.gastos_agregado_origen && prev.gastos_detalle_origen) {
    const ao = prev.gastos_agregado_origen;
    const do_ = prev.gastos_detalle_origen;
    return {
      agregado: ao.valor,
      agregadoTurn: ao.turn,
      detalle: do_.valor,
      detalleTurn: do_.turn,
      diff: round2(do_.valor - ao.valor),
      diffPct: ao.valor !== 0 ? (Math.abs(do_.valor - ao.valor) / Math.abs(ao.valor)) * 100 : Infinity,
      attempts: 0,
      detalleCompleta: do_.completa ?? false,
    };
  }
  return null;
}

// ── V16 (revisión AG01, tanda 2) — GUARDA DE DOBLE CONTEO ────────────────────
//
// BLOQUEANTE 1 (medido en revisión adversarial): "gasté 1800: renta 900,
// comida 500, luz 400" — antes de la extensión de GASTO_CTX/
// GASTO_AGREGADO_DETALLE_RE (ver arriba), el pretérito "gasté" no activaba
// NINGÚN patrón declarativo y el mensaje entero caía al parser de listas:
// "gasté" se emparejaba como NOMBRE de un ítem con 1800 de importe, y el
// agregado (1800) se sumaba una SEGUNDA vez dentro del propio detalle
// (900+500+400+1800=3600, el doble de lo real). El fix primario (cobertura
// de "gaste") ya lo evita en ese caso concreto; esta guarda es DEFENSA EN
// PROFUNDIDAD para cualquier otra vía de extracción (presente o futura) que
// pudiera repetir el mismo error: nunca debe haber un ítem cuyo importe sea
// EXACTAMENTE el agregado declarado en el MISMO mensaje.
//
// Quirúrgica, a diferencia de la guarda de sanidad (FIX 4, más abajo): esa
// descarta el detalle ENTERO ante una señal de error genérica; esta retira
// SOLO el ítem fantasma — el resto de las partidas reales del mismo mensaje
// no tienen por qué perderse.
function aplicarGuardaV16(delta: Partial<ScenarioState>): Partial<ScenarioState> {
  if (delta.gastos_mensuales === undefined || !delta.gastos_items || delta.gastos_items.length === 0) {
    return delta;
  }
  const agregado = delta.gastos_mensuales;
  const idxFantasma = delta.gastos_items.findIndex((i) => i.amount === agregado);

  let limpio = delta;
  if (idxFantasma !== -1) {
    const items = delta.gastos_items.filter((_, i) => i !== idxFantasma);
    console.warn("[guardaV16] ítem fantasma descartado (doble conteo del agregado)", JSON.stringify({
      agregado,
      item_descartado: delta.gastos_items[idxFantasma],
    }));

    limpio = { ...delta, gastos_items: items };
    if (items.length >= 2) {
      const cls = classifyExpenses(items);
      limpio.gastos_detalle = { vitales: cls.vitales.total, noVitales: cls.noVitales.total, desconocidos: cls.desconocidos.total };
    } else {
      // Sin el fantasma ya no queda una lista real (<2 ítems) — no hay detalle
      // que oponer al agregado; V1: el agregado en sí nunca se toca.
      delete limpio.gastos_detalle;
      delete limpio.gastos_es_detalle;
    }
  }

  // VERIFICACIÓN DE SUMA (V16, 13ª tanda) — segunda mitad de la guarda: el
  // ítem fantasma es la forma CONOCIDA del doble conteo (un importe repetido
  // exactamente), pero no la única concebible. Si la suma del desglose EXCEDE
  // el agregado declarado en el mismo mensaje, o hay doble conteo o hay un
  // error de lectura — en cualquier caso el turno NO puede salir en silencio.
  //
  // Deliberadamente solo DETECTA y avisa, no corrige: quién gana entre
  // agregado y desglose es competencia de `reconciliarGastos` (§6,
  // materialidad + CONFLICT), que ya recibe ambos valores intactos y decide
  // con reglas explícitas. Corregir aquí sería elegir en silencio — justo lo
  // que el principio §0 prohíbe. El log es la red de seguridad: si aparece
  // sin un CONFLICT/reinicio posterior que lo justifique, es un bug.
  const items = limpio.gastos_items ?? [];
  if (items.length > 0) {
    const suma = round2(items.reduce((acc, i) => acc + i.amount, 0));
    if (suma > agregado + TOLERANCIA_REDONDEO_EUR) {
      console.warn("[guardaV16] la suma del desglose EXCEDE el agregado declarado — debe resolverlo la reconciliación (§6), nunca en silencio", JSON.stringify({
        agregado,
        suma_items: suma,
        exceso: round2(suma - agregado),
        items: items.map((i) => ({ name: i.name, amount: i.amount })),
      }));
    }
  }

  return limpio;
}

// ── FIX 4 (9ª tanda) — GUARDA DE SANIDAD (defensa en profundidad) ───────────
//
// El reclamo por valor (FIX 1) cierra el agujero en la vía regex, pero NO
// protege la vía tool_call (el LLM puede, en teoría, devolver un desglose
// donde una partida repita el ingreso, o cuya suma sea absurda respecto al
// ingreso) — de ahí que esta guarda sea una función aparte, invocada tanto
// aquí como en `toolArgsToScenarioDelta`, y no solo lógica interna del
// parser regex.
const MULTIPLICADOR_MAGNITUD_ABSURDA = 3;

/**
 * V12 — el ingreso NUNCA puede aparecer como ítem de gasto. Magnitud absurda
 * — la suma del detalle no puede superar 3× el ingreso del MISMO delta (un
 * desglose que "cuesta" más que el triple de lo que se gana es indicio de
 * error de lectura, no de un presupuesto real). Ante cualquiera de las dos,
 * el detalle (buckets + items) se descarta ENTERO — nunca a medias, para no
 * dejar buckets que ya no cuadran con los items — pero `gastos_mensuales` /
 * `ingreso_mensual` NUNCA se tocan (V1): solo se retira lo que es dudoso.
 */
export function aplicarGuardaDeSanidad(delta: Partial<ScenarioState>): Partial<ScenarioState> {
  if (!delta.gastos_items || delta.gastos_items.length === 0) return delta;
  if (delta.ingreso_mensual === undefined) return delta;

  const ingresoDuplicado = delta.gastos_items.some((i) => i.amount === delta.ingreso_mensual);
  const suma = delta.gastos_items.reduce((acc, i) => acc + i.amount, 0);
  const magnitudAbsurda = suma > delta.ingreso_mensual * MULTIPLICADOR_MAGNITUD_ABSURDA;

  if (!ingresoDuplicado && !magnitudAbsurda) return delta;

  console.warn("[guardaDeSanidad] detalle de gastos descartado", JSON.stringify({
    motivo: ingresoDuplicado ? "ingreso_duplicado_como_gasto" : "magnitud_absurda",
    ingreso_mensual: delta.ingreso_mensual,
    suma_items: suma,
    items: delta.gastos_items,
  }));

  const limpio = { ...delta };
  delete limpio.gastos_items;
  delete limpio.gastos_detalle;
  delete limpio.gastos_es_detalle;
  return limpio;
}

// ── PIEZA 1 (5ª tanda) — DETECTOR DE NÚMEROS HUÉRFANOS ───────────────────────
//
// CASO REAL: "gano 2300 y gasto= 1000 arriendo 500 servicios 250 carro 100
// ropa" — el sistema publicó gastos=1000 (el primer número tras "gasto") con
// gasto real de 1850 (la suma del desglose). La calculadora computó BIEN
// sobre un insumo FALSO: el hueco está en la entrada, no en el cálculo.
//
// PRINCIPIO: "Ningún dato entra al estado sin que el usuario lo vea. Ante
// ambigüedad de extracción se PREGUNTA, nunca se asume." Tras extraer el
// delta (tool call o fallback regex), se cuenta:
//   N = números en el mensaje que PARECEN financieros.
//   M = de esos, cuántos aterrizaron en algún campo del delta.
// N − M ≥ 1 ⇒ extraccion_incompleta = true.

// Sustantivos NO monetarios que, pegados a un número, lo excluyen del conteo
// ("3 hijos", "2 personas"). "años"/"meses" YA quedan fuera vía duración
// (unidad de tiempo, ver TIEMPO_AFTER_RE) — ni un plazo de crédito ni una edad
// son dinero.
//
// PIEZA 2 (8ª tanda) — vocabulario ampliado: horas, kg, m²/m2, habitaciones,
// edad, grados (ES/PT/EN). Test obligatorio (caso 11): "gano 2300, tengo 43
// años, 2 hijos, gasto 2200" → COMPLETE, sin preguntar por 43 ni 2 — sin este
// vocabulario el sistema se paraliza pidiendo la edad.
const SUSTANTIVO_NO_MONETARIO_AFTER_RE =
  /^\s*(?:hijos?|hijas?|filhos?|filhas?|kids?|child(?:ren)?|ni[ñn]os?|personas?|people|veces|times|kg|kgs|kilos?|m2|m²|habitaciones?|hab|quartos?|rooms?|edad|idade|age|grados?|graus|degrees?)\b/;
const TIEMPO_AFTER_RE =
  /^\s*(?:a[ñn]os?|anos?|years?|meses|mes|months?|d[ií]as?|days?|semanas?|weeks?|horas?|hours?)\b/;

// FIX G1d (fidelidad de extracción) — una tasa mencionada SIN el signo "%"
// ("TAE 9", "tasa del 9") es un dato genuinamente ambiguo, no un importe
// perdido: el extractor de crédito exige "%" por diseño (evita falsos
// positivos con cualquier otro número de la frase — ver informe "crédito
// fantasma"), así que "9" nunca llega a `credito.tae_pct`. Sin esta regla,
// "quiero un carro de 30000 a 48 meses con TAE 9" degradaba a PARTIAL por
// ese único número — aunque monto y plazo, los dos importes CLAROS de la
// frase, ya se hubieran capturado bien. Se clasifica como NO RELEVANTE
// (mismo trato que "43 años"/"2 hijos") solo cuando NO hay "%" ni marca de
// moneda inmediatamente después — si cualquiera de las dos aparece, es un
// importe claro (una tasa con signo, o un cargo de intereses en euros) y
// SIGUE contando como candidato financiero normal.
const TASA_BEFORE_RE = /\b(?:tae|tasa|inter[ée]s|apr)\b[^\d%]{0,10}$/i;
const MONEDA_AFTER_RE = /^\s*(?:€|eur\b|euros?\b|\$|usd\b|d[oó]lares?\b|dollars?\b)/i;

function esTasaSinSigno(text: string, m: NumberMention): boolean {
  const before = text.slice(Math.max(0, m.start - 20), m.start);
  const after = text.slice(m.end, m.end + 15);
  if (!TASA_BEFORE_RE.test(before)) return false;
  if (/^\s*%/.test(after)) return false;
  if (MONEDA_AFTER_RE.test(after)) return false;
  return true;
}

/** ¿`m` es un enumerador de lista ("1. Ajustar…")? Mismo criterio que validate.ts. */
function esEnumeradorDeLista(text: string, m: NumberMention): boolean {
  const lineStart = text.lastIndexOf("\n", m.start - 1) + 1;
  const prefix = text.slice(lineStart, m.start);
  if (!/^[ \t]*$/.test(prefix)) return false;
  return /^ ?[.)-]/.test(text.slice(m.end, m.end + 3));
}

/** ¿`m` es una cifra CANDIDATA a financiera? (no enumerador, no duración, no sustantivo no-monetario). */
function esCandidataFinanciera(text: string, m: NumberMention): boolean {
  if (esEnumeradorDeLista(text, m)) return false;
  const after = text.slice(m.end, m.end + 20);
  if (TIEMPO_AFTER_RE.test(after)) return false;
  if (SUSTANTIVO_NO_MONETARIO_AFTER_RE.test(after)) return false;
  if (esTasaSinSigno(text, m)) return false;
  return true;
}

/**
 * Números candidatos a financieros del mensaje (N del detector). Exportada
 * también para el llamante (route.ts/harness): cuando la extracción es
 * ambigua, el modelo necesita poder CITAR cualquiera de estos números al
 * preguntar ("¿tu ingreso ronda los 2.000 € o los 2.500 €?") sin que el
 * guardarraíl de cifras los bloquee por no ser una derivada verificada — son
 * el eco de lo que el propio usuario escribió, no una cifra inventada.
 */
export function numerosCandidatos(message: string): number[] {
  return dedupeOverlaps(findNumberMentions(message))
    .filter((m) => esCandidataFinanciera(message, m))
    .map((m) => m.value);
}

// FIX (reserva de AG01, cierre G1d) — la tolerancia ÷12/×12 (año↔mes) solo se
// admite cuando el número tiene una marca ANUAL explícita pegada en el texto
// ("al año", "anual", "por año", "yearly", "por ano"). Sin ella, degenera en
// una PUERTA TRASERA para el multiset: un AGREGADO (p. ej. 1200, la suma de
// solo 2 de 3 partidas capturadas) puede "cubrir" por pura aritmética una
// partida perdida cuyo valor sea agregado/12 (1200/12 = 100) — el mismo
// punto ciego que el fix de multiset debía cerrar, reabierto por otra vía.
const MARCA_ANUAL_RE = /\b(?:al\s+a[ñn]o|anual(?:mente)?|por\s+a[ñn]o|por\s+ano|yearly|per\s+year|annual(?:ly)?)\b/i;

function tieneMarcaAnual(text: string, m: NumberMention): boolean {
  const before = text.slice(Math.max(0, m.start - 15), m.start);
  const after = text.slice(m.end, m.end + 15);
  return MARCA_ANUAL_RE.test(before) || MARCA_ANUAL_RE.test(after);
}

interface CandidatoConMarca {
  value: number;
  /** ¿Este número trae "al año"/"anual"/etc. pegado en el propio mensaje? */
  anual: boolean;
}

/** Como `numerosCandidatos`, pero conserva si cada uno trae marca ANUAL explícita. */
function numerosCandidatosConMarca(message: string): CandidatoConMarca[] {
  return dedupeOverlaps(findNumberMentions(message))
    .filter((m) => esCandidataFinanciera(message, m))
    .map((m) => ({ value: m.value, anual: tieneMarcaAnual(message, m) }));
}

/**
 * FIX G1d (fidelidad de extracción, evento 22 ago) — MULTISET, no membership.
 * La versión anterior (`coincideConAsignado`, un `.some()` de PERTENENCIA)
 * dejaba que UNA sola partida capturada "cubriera" TODAS las apariciones del
 * mismo valor en el mensaje: si el tool_call capturaba "cuota 50" pero
 * perdía "ayuda a mi madre 50" (una partida DISTINTA, mismo importe), el
 * candidato 50 de la partida perdida encontraba el 50 de "cuota" YA
 * asignado y se daba por cubierto — nunca se preguntaba por él. Caso real:
 * 6 de 17 partidas se perdieron (5, 20, 10, 10, 50, 30 — 125 €) y el sistema
 * certificó COMPLETE con 2.080 € en vez de PARTIAL citando lo que faltaba,
 * porque sus importes coincidían por VALOR con otras partidas SÍ capturadas.
 *
 * Fix: cada valor asignado se CONSUME (se retira de la bolsa) al cubrir un
 * candidato — no puede volver a cubrir otro. Dos pasadas para no depender
 * del ORDEN de aparición: primero se resuelven todas las coincidencias
 * EXACTAS (para que una pareja "floja" ±1/año↔mes de un candidato no le
 * robe a otro candidato su pareja exacta), y solo con lo que sobra de ambos
 * lados se intenta la tolerancia — redondeo ±1 SIEMPRE; conversión ÷12/×12
 * año↔mes SOLO si el candidato trae marca anual explícita (ver
 * `tieneMarcaAnual` — reserva de AG01, cierre de G1d: sin esta condición, el
 * ÷12/×12 reabre el mismo punto ciego que el multiset cerraba, por la vía
 * de un AGREGADO que "cubre" una partida perdida cuyo valor es agregado/12).
 */
function huerfanosPorMultiset(candidatos: CandidatoConMarca[], asignados: number[]): number[] {
  const restantes = [...asignados];
  const pendientes: CandidatoConMarca[] = [];
  for (const c of candidatos) {
    const idx = restantes.indexOf(c.value);
    if (idx !== -1) restantes.splice(idx, 1);
    else pendientes.push(c);
  }
  const sinDestino: number[] = [];
  for (const c of pendientes) {
    const idx = restantes.findIndex(
      (a) =>
        Math.abs(a - c.value) <= 1 ||
        (c.anual && (Math.abs(a - c.value / 12) <= 1 || Math.abs(a - c.value * 12) <= 1)),
    );
    if (idx !== -1) restantes.splice(idx, 1);
    else sinDestino.push(c.value);
  }
  return sinDestino;
}

/**
 * Valores numéricos que ATERRIZARON en algún campo del delta (M del
 * detector), incluyendo cada ítem individual de `gastos_detalle` — los
 * totales por grupo no coincidirían nunca con un número suelto del mensaje,
 * así que se RE-DERIVAN los ítems con el mismo parser que usó la extracción
 * (determinista, sin efectos secundarios).
 */
function valoresAsignadosEnDelta(message: string, delta: Partial<ScenarioState>): number[] {
  void message; // se conserva en la firma por compatibilidad; ya no se re-deriva nada de él.
  const vals: number[] = [];
  if (delta.ingreso_mensual !== undefined) vals.push(delta.ingreso_mensual);
  if (delta.gastos_mensuales !== undefined) vals.push(delta.gastos_mensuales);
  // FIX V14-3 (11ª tanda) — usa los ítems YA ASIGNADOS en `delta.gastos_items`
  // directamente, en vez de RE-DERIVARLOS con `parseExpenseList(message)` (sin
  // los rangos reclamados por FIX V14-1). La re-derivación podía producir un
  // conjunto de ítems DISTINTO al que de verdad se asignó — y, más grave,
  // ocultaba números que sí quedaron sin destino (ley de conservación, V14):
  // si `parseExpenseList` "adivinaba" un ítem que `extractScenarioDelta` NUNCA
  // asignó, ese número se contaba como cubierto sin estarlo.
  if (delta.gastos_items) {
    for (const item of delta.gastos_items) vals.push(item.amount);
  }
  if (delta.credito) {
    if (delta.credito.monto) vals.push(delta.credito.monto);
    if (delta.credito.plazo_meses) vals.push(delta.credito.plazo_meses);
    if (delta.credito.tae_pct !== undefined) vals.push(delta.credito.tae_pct);
  }
  if (delta.meta) {
    if (delta.meta.monto !== undefined) vals.push(delta.meta.monto);
    if (delta.meta.plazo_meses !== undefined) vals.push(delta.meta.plazo_meses);
  }
  return vals;
}

export interface ExtraccionIncompletaResult {
  extraccionIncompleta: boolean;
  numerosHuerfanos: number[];
  /**
   * PIEZA 2 (8ª tanda) — números del mensaje que el detector VIO pero
   * CLASIFICÓ como NO RELEVANTES (edad, nº de hijos, duración, unidades…):
   * se ignoran y NUNCA degradan `extraction_status` — informativo, para
   * telemetría/depuración, no para preguntar por ellos.
   */
  numerosNoRelevantes: number[];
}

/** ¿Por qué `m` NO es una cifra financiera candidata? `null` si SÍ lo es. */
function razonNoRelevante(text: string, m: NumberMention): "tiempo" | "sustantivo" | "tasa" | null {
  if (esEnumeradorDeLista(text, m)) return null; // ni siquiera es un número candidato real.
  const after = text.slice(m.end, m.end + 20);
  if (TIEMPO_AFTER_RE.test(after)) return "tiempo";
  if (SUSTANTIVO_NO_MONETARIO_AFTER_RE.test(after)) return "sustantivo";
  if (esTasaSinSigno(text, m)) return "tasa";
  return null;
}

/**
 * Detector de números huérfanos (PIEZA 1). Puro; corre TRAS extraer el delta,
 * sea por tool call o por fallback regex — ambos producen un
 * `Partial<ScenarioState>`, así que el detector es agnóstico a la vía.
 */
export function detectarNumerosHuerfanos(
  message: string,
  delta: Partial<ScenarioState>,
): ExtraccionIncompletaResult {
  const candidatos = numerosCandidatosConMarca(message);
  // FIX CRÉDITO FANTASMA (follow-up) — "a 48 meses: cuota 900, seguro 50" no
  // tiene ningún crédito al que pertenecer (`extractScenarioDelta` ya decidió
  // no escribir `delta.credito` por esa misma razón). `esCandidataFinanciera`
  // excluye TODO número seguido de una unidad de tiempo de `numerosCandidatos`
  // — correcto para el caso general (un plazo que SÍ completa un crédito no
  // debe generar ruido), pero aquí no hay crédito que completar: es un dato
  // suelto que el usuario escribió y que debe preguntarse, no perderse en
  // silencio (V14). Se añade explícitamente porque el filtro general, por
  // diseño, nunca lo deja llegar a `candidatos` — se incorpora ANTES del
  // emparejamiento multiset para que compita por una pareja en igualdad de
  // condiciones con el resto. Un plazo suelto nunca lleva marca anual.
  if (!delta.credito) {
    const plazoSuelto = plazoSueltoConLista(message);
    if (plazoSuelto !== null) candidatos.push({ value: plazoSuelto, anual: false });
  }
  const asignados = valoresAsignadosEnDelta(message, delta);
  const numerosHuerfanos = huerfanosPorMultiset(candidatos, asignados);
  const numerosNoRelevantes = dedupeOverlaps(findNumberMentions(message))
    .filter((m) => razonNoRelevante(message, m) !== null)
    .map((m) => m.value);
  return { extraccionIncompleta: numerosHuerfanos.length > 0, numerosHuerfanos, numerosNoRelevantes };
}

// ── PIEZA 2 (5ª tanda) — RECONCILIACIÓN ARITMÉTICA ───────────────────────────
//
// CASO REAL (variante): "gasto 1000: 500 arriendo 250 carro 100 ropa" — el
// agregado declarado (1000) NO coincide con la suma del detalle (850). No se
// elige uno en silencio: se pregunta cuál es el correcto.
export interface DiscrepanciaGastosResult {
  discrepancia: boolean;
  agregado?: number;
  suma?: number;
}

/**
 * ¿El agregado declarado (`gastos_mensuales`) y la suma del desglose
 * (`gastos_detalle`) se contradicen? Solo aplica cuando AMBOS llegaron en el
 * MISMO delta (ver `GASTO_AGREGADO_DETALLE_RE` en `extractScenarioDelta`) —
 * el caso normal (solo detalle, sin agregado propio) nunca dispara esto.
 */
export function detectarDiscrepanciaGastos(delta: Partial<ScenarioState>): DiscrepanciaGastosResult {
  if (delta.gastos_mensuales === undefined || !delta.gastos_detalle) return { discrepancia: false };
  const suma = round2(
    delta.gastos_detalle.vitales + delta.gastos_detalle.noVitales + delta.gastos_detalle.desconocidos,
  );
  const agregado = delta.gastos_mensuales;
  if (Math.abs(suma - agregado) <= 1) return { discrepancia: false };
  return { discrepancia: true, agregado, suma };
}

/**
 * Nota de aclaración para el system prompt cuando la extracción es ambigua
 * (PIEZA 1/2 · orquestador).
 *
 * BUG BLOQUEANTE (6ª tanda, testdev5) — la versión anterior de esta pieza
 * hacía que un huérfano DESCARTARA el delta completo (`deltaSeguro`
 * eliminaba ingreso_mensual/gastos_mensuales/credito/meta aunque esos campos
 * se hubieran extraído con confianza). Un mensaje real con ingreso y gastos
 * limpios más un par de cifras de una meta sin decidir aún (p. ej. "casa de
 * 200000 o 300000, quizá 150000") perdía el ingreso y los gastos para
 * SIEMPRE — nada se persistía. Corregido: los huérfanos son SOLO una
 * pregunta de aclaración; NUNCA tocan campos ya extraídos con confianza. Por
 * eso esta nota ya NO dice "cero cifras derivadas" para huérfanos — lo que
 * SÍ se sabe se calcula igual; solo se pide aclarar los números sueltos.
 *
 * La discrepancia de gastos sigue siendo distinta: agregado y desglose son
 * DOS lecturas del MISMO campo que se contradicen, así que ese campo (y solo
 * ese) no se usa hasta reconciliar — ver `deltaSinGastosPorDiscrepancia`.
 *
 * PRIORIDAD: una discrepancia aritmética es más concreta que un huérfano
 * genérico — si hay ambas, se pregunta por la discrepancia primero (el
 * huérfano probablemente sea el mismo número). `null` si nada es ambiguo.
 */
export function notaExtraccionAmbigua(
  huerfanos: ExtraccionIncompletaResult,
  discrepancia: DiscrepanciaGastosResult,
  itemSospechoso?: ItemSospechoso | null,
): string | null {
  if (discrepancia.discrepancia) {
    return (
      `DISCREPANCIA ARITMÉTICA: el usuario declaró un total de gastos de ${discrepancia.agregado} € pero ` +
      `el detalle suma ${discrepancia.suma} €. Pregunta cuál es el correcto antes de dar una cifra de ` +
      "gastos o cualquier derivada que dependa de ellos (sobrante, capacidad, viabilidad de una cuota). " +
      "El resto de los datos que ya tienes (ingreso, meta, crédito…) SÍ los puedes usar con normalidad."
    );
  }
  // PIEZA 6 (8ª tanda) — ítem sospechoso de pegado: más concreto que un
  // huérfano genérico (ya sabemos EXACTAMENTE qué partida dudar), así que
  // tiene prioridad sobre el aviso genérico de huérfanos. El resto de
  // partidas SÍ se usan con normalidad (V1) — solo se pregunta por esta.
  if (itemSospechoso) {
    return (
      `POSIBLE CIFRA PEGADA: ${itemSospechoso.sugerencia} Pregunta con calidez para confirmar la lectura ` +
      "correcta antes de dar por cerrado el desglose de gastos. El resto de las partidas que sí quedaron " +
      "claras las puedes usar con normalidad."
    );
  }
  if (huerfanos.extraccionIncompleta) {
    return (
      `NÚMEROS SIN ASIGNAR: el usuario mencionó ${huerfanos.numerosHuerfanos.join(", ")} y no quedó claro a ` +
      "qué corresponden. Pregúntale a qué se refieren — con calidez, no como un interrogatorio — pero eso " +
      "NO te impide seguir usando con normalidad los datos que SÍ tienes claros de este mismo mensaje " +
      "(ingreso, gastos, meta, crédito…): calcula con esos igual, y añade la pregunta de los números " +
      "sueltos aparte."
    );
  }
  return null;
}

// ── PIEZA 1 (8ª tanda) — EXTRACTION_STATUS ───────────────────────────────────
//
// "Antes de decir que el usuario se contradijo, el sistema debe preguntarse si
// lo leyó bien." Resume en UN valor cuál de las señales ya existentes (huérfanos,
// discrepancia, ítem sospechoso, valor inválido) aplica a este turno — NUNCA
// degrada nada por sí solo: la afectación real ya la deciden esas mismas
// piezas (huérfanos no descartan el delta — V1; discrepancia solo retiene
// gastos; item_sospechoso solo pregunta, el ítem se usa igual).

// Campos con contexto de alta confianza donde un CERO explícito es un
// placeholder rechazable (V8), no un dato real. No cubre negativos: el
// parser de montos (`AMOUNT`) no captura signo, así que un negativo nunca
// llega a `delta` — no hace falta detectarlo aparte.
const CAMPOS_CON_CONTEXTO_CERO: Array<[string, RegExp]> = [
  ["ingreso_mensual", INGRESO_CTX],
  ["gastos_mensuales", GASTO_CTX],
];

/**
 * PIEZA 1 — campos con un CERO explícito mencionado en contexto financiero
 * ("gano 0", "gasto 0 este mes"). Un cero así NUNCA se persiste (V8, ya
 * vigente vía los filtros `> 0` de `extractScenarioDelta`) — esto solo hace
 * VISIBLE por qué ese campo se quedó sin asignar, en vez de fallar en
 * silencio como un huérfano genérico.
 */
export function detectarValoresInvalidos(message: string): string[] {
  const n = norm(message);
  const invalidos: string[] = [];
  for (const [campo, ctxRe] of CAMPOS_CON_CONTEXTO_CERO) {
    if (!ctxRe.test(n)) continue;
    const m = AMOUNT.exec(n.slice(n.search(ctxRe)));
    if (!m) continue;
    const v = parseDigitAmount(m[1]);
    if (Number.isFinite(v) && v <= 0) invalidos.push(campo);
  }
  return invalidos;
}

export interface ExtractionStatusInputs {
  huerfanos: ExtraccionIncompletaResult;
  discrepancia: DiscrepanciaGastosResult;
  itemSospechoso: ItemSospechoso | null;
  camposInvalidos: string[];
}

/**
 * PIEZA 1 — el resumen de una línea que el resto del sistema (eco, telemetría)
 * puede leer sin tener que re-derivar las cuatro señales. Prioridad: INVALID
 * (un campo quedó MISSING por un valor imposible) > AMBIGUOUS (discrepancia o
 * pegado — más concreto) > PARTIAL (huérfanos genéricos) > COMPLETE.
 */
export function computeExtractionStatus(inputs: ExtractionStatusInputs): ExtractionStatus {
  if (inputs.camposInvalidos.length > 0) return "INVALID";
  if (inputs.discrepancia.discrepancia || inputs.itemSospechoso) return "AMBIGUOUS";
  if (inputs.huerfanos.extraccionIncompleta) return "PARTIAL";
  return "COMPLETE";
}

export interface AnalisisExtraccion {
  extraction_status: ExtractionStatus;
  huerfanos: ExtraccionIncompletaResult;
  discrepancia: DiscrepanciaGastosResult;
  itemSospechoso: ItemSospechoso | null;
  camposInvalidos: string[];
}

/**
 * MAYOR 3 (revisión AG01, QA testdev8) — el rango que `GASTO_AGREGADO_DETALLE_RE`
 * reclamó como agregado declarado ("gastos fueron 2 200:"), si lo hay. Sin
 * excluir este rango, el re-parseo de `analizarExtraccion` (más abajo) lee
 * "2 200" como si fuera parte del DESGLOSE — el propio agregado, ya asignado
 * correctamente por `extractScenarioDelta`, se marca a sí mismo como una
 * cifra "pegada" (`itemSospechoso`) y dispara una AMBIGUOUS/pregunta de
 * aclaración fantasma sobre un número que el motor ya leyó bien.
 */
function rangoAgregadoDeclarado(message: string): Rango | null {
  const n = norm(message);
  const m = GASTO_AGREGADO_DETALLE_RE.exec(n);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length };
}

/**
 * PIEZA 1 — punto de entrada ÚNICO para analizar la honestidad de la
 * extracción de este turno: corre las cuatro señales (huérfanos,
 * discrepancia, ítem sospechoso de pegado, valores inválidos) y resume el
 * resultado en `extraction_status`. Puro; no muta nada — el llamante
 * (route.ts) decide qué hacer con cada señal (igual que ya hacía antes de
 * existir esta función, que solo las agrupa).
 */
export function analizarExtraccion(message: string, delta: Partial<ScenarioState>): AnalisisExtraccion {
  const huerfanos = detectarNumerosHuerfanos(message, delta);
  const discrepancia = detectarDiscrepanciaGastos(delta);
  // MAYOR 3 — excluye el rango del agregado declarado (si lo hay) del
  // re-parseo: la misma frontera que `extractScenarioDelta` ya aplicó al
  // extraer el delta real, para que el detector de pegado juzgue la MISMA
  // lista que se persiste, no una relectura sin fronteras.
  const rangoAgregado = rangoAgregadoDeclarado(message);
  const itemSospechoso = delta.gastos_es_detalle
    ? parseExpenseListDetallado(message, delta.gastos_mensuales, rangoAgregado ? [rangoAgregado] : undefined).itemSospechoso
    : null;
  const camposInvalidos = detectarValoresInvalidos(message);
  const extraction_status = computeExtractionStatus({ huerfanos, discrepancia, itemSospechoso, camposInvalidos });
  return { extraction_status, huerfanos, discrepancia, itemSospechoso, camposInvalidos };
}

/**
 * Copia del delta sin los campos DE GASTOS — se usa SOLO cuando hay
 * discrepancia aritmética (agregado ≠ suma del desglose, el mismo campo
 * contándose a sí mismo dos veces de forma contradictoria). El resto del
 * delta (ingreso, crédito, meta, señales no numéricas…) se persiste igual:
 * "ningún dato entra sin que el usuario lo vea" se aplica al campo ambiguo,
 * NUNCA al mensaje entero.
 *
 * BUG BLOQUEANTE (6ª tanda) — esta función reemplaza a la antigua
 * `deltaSeguro`, que despojaba TODO campo financiero (ingreso, crédito, meta
 * incluidos) ante CUALQUIER huérfano en el mensaje, aunque esos campos se
 * hubieran extraído con confianza y no tuvieran nada que ver con la
 * ambigüedad. Un huérfano YA NO despoja nada — ver `notaExtraccionAmbigua`.
 */
export function deltaSinGastosPorDiscrepancia(
  delta: Partial<ScenarioState>,
  discrepancia: DiscrepanciaGastosResult,
): Partial<ScenarioState> {
  if (!discrepancia.discrepancia) return delta;
  const sinGastos = { ...delta };
  delete sinGastos.gastos_mensuales;
  delete sinGastos.gastos_detalle;
  delete sinGastos.gastos_es_detalle;
  return sinGastos;
}

// ── PIEZA 3 (5ª tanda) — ECO DE CONFIRMACIÓN ─────────────────────────────────
//
// El mecanismo GENERAL, no solo para este caso: cuando el turno SÍ extrajo
// datos limpios (sin huérfanos ni discrepancia), la primera línea de la
// respuesta DEBE devolver lo entendido antes de usarlo — así el usuario ve el
// dato y puede corregirlo si está mal, en vez de descubrirlo tres cifras
// derivadas más tarde. Esta función expone los HECHOS de lo que el delta trae;
// la REDACCIÓN (voz, calidez) es del modelo — ver consigliere.ts.
export function renderDatosRecienEntendidos(
  delta: Partial<ScenarioState>,
  message: string,
  /**
   * MAYOR 6 (QA testdev8) — resultado YA fusionado de una corrección de ítem
   * (`delta.gastos_item_correccion`): el delta por sí solo no trae el nuevo
   * total ni si generó conflicto — ambos salen de `mergeScenario`. Opcional:
   * sin esto, la corrección se sigue enunciando (nombre + importe corregido),
   * solo sin el total recalculado.
   */
  postCorreccion?: { gastosMensualesNuevo?: number; enConflicto?: boolean },
): string | null {
  const partes: string[] = [];
  if (delta.ingreso_mensual !== undefined) partes.push(`ingreso mensual: ${delta.ingreso_mensual} €`);
  if (delta.gastos_es_detalle && delta.gastos_detalle) {
    // `gastos_mensuales` puede no venir en el delta (el caso normal: solo
    // detalle, sin agregado propio — `mergeScenario` lo recalcula al fusionar).
    // El total a mostrar en el eco es la suma del propio desglose.
    const total = delta.gastos_mensuales ?? round2(
      delta.gastos_detalle.vitales + delta.gastos_detalle.noVitales + delta.gastos_detalle.desconocidos,
    );
    const items = parseExpenseList(message);
    const desglose = items.length > 0 ? ` (${items.map((i) => `${i.name} ${i.amount}`).join(", ")})` : "";
    partes.push(`gastos mensuales: ${total} €${desglose}`);
  } else if (delta.gastos_mensuales !== undefined) {
    partes.push(`gastos mensuales: ${delta.gastos_mensuales} €`);
  }
  if (delta.credito) {
    if (delta.credito.monto) partes.push(`monto del crédito: ${delta.credito.monto} €`);
    if (delta.credito.plazo_meses) partes.push(`plazo: ${delta.credito.plazo_meses} meses`);
    if (delta.credito.tae_pct !== undefined) partes.push(`TAE: ${delta.credito.tae_pct}%`);
  }
  if (delta.meta) {
    if (delta.meta.titulo) partes.push(`meta: ${delta.meta.titulo}`);
    if (delta.meta.monto !== undefined) partes.push(`monto de la meta: ${delta.meta.monto} €`);
    if (delta.meta.plazo_meses !== undefined) partes.push(`plazo de la meta: ${delta.meta.plazo_meses} meses`);
  }
  // MAYOR 6 (QA testdev8) — "me equivoqué, el ocio son 150" aplicaba el
  // cambio pero la respuesta NUNCA lo mencionaba: sin esta rama, una
  // corrección de ítem con `partes` vacío (nada más nuevo este turno) hacía
  // que la función devolviera `null` — ni una sola frase que la enunciara.
  if (delta.gastos_item_correccion) {
    const { name, amount } = delta.gastos_item_correccion;
    let parte = `corrección: ${name} ahora es ${amount} €`;
    if (postCorreccion?.gastosMensualesNuevo !== undefined && !postCorreccion.enConflicto) {
      parte += ` (tus gastos totales pasan a ${postCorreccion.gastosMensualesNuevo} €)`;
    }
    partes.push(parte);
  }
  if (partes.length === 0) return null;
  const notaCorreccion = delta.gastos_item_correccion
    ? postCorreccion?.enConflicto
      ? " Esta es una CORRECCIÓN aceptada: acúsala explícitamente en tu respuesta. Además, el desglose corregido ya NO cuadra con un total que el usuario había declarado antes — díselo con tus propias palabras (el sistema te da los dos valores en conflicto más abajo) y pídele que confirme cuál es el correcto."
      : " Esta es una CORRECCIÓN aceptada: acúsala explícitamente en tu respuesta (nunca la apliques en silencio)."
    : "";
  return (
    `DATOS RECIÉN ENTENDIDOS (este turno): ${partes.join("; ")}. ` +
    "Tu PRIMERA línea devuelve esto de forma compacta y natural (con tu propia voz, no copies este " +
    "formato) antes de usar estas cifras — ver la regla de ECO del prompt. Si el usuario corrige un " +
    "dato, el dato corregido manda. No repitas el eco si ya lo hiciste con los mismos datos." + notaCorreccion
  );
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ── PIEZA 6 (8ª tanda) — FACT_STATUS: EL ECO COMO PROMOTOR DE CONFIANZA ──────
//
// Por campo: MISSING (nunca se ha visto) → PARSED (extraído, confianza media)
// → CONFIRMED (el eco lo enunció y el usuario NO lo corrigió el turno
// siguiente). El eco YA EXISTE (`renderDatosRecienEntendidos`); esto lo
// convierte en el MECANISMO de promoción — el sistema entrega los datos, la
// frase la redacta el modelo. CONFLICT/ASSUMED/SUPERSEDED son de la tanda
// siguiente: aquí solo hay ida (PARSED→CONFIRMED) y reset ante una corrección
// (un valor nuevo y distinto vuelve a PARSED, nunca se queda CONFIRMED a
// ciegas).

/** Los ocho campos escalares que llevan fact_status. */
function valorCampo(s: Partial<ScenarioState> | undefined, campo: string): unknown {
  switch (campo) {
    case "ingreso_mensual": return s?.ingreso_mensual;
    case "gastos_mensuales": return s?.gastos_mensuales;
    case "credito_monto": return s?.credito?.monto;
    case "credito_plazo": return s?.credito?.plazo_meses;
    case "credito_tae": return s?.credito?.tae_pct;
    case "meta_monto": return s?.meta?.monto;
    case "meta_plazo": return s?.meta?.plazo_meses;
    case "meta_titulo": return s?.meta?.titulo;
    default: return undefined;
  }
}

/** ¿Qué campos escalares trae EXPLÍCITAMENTE este delta (para fact_status y para el eco_pendiente del turno)? */
function camposDelDelta(delta: Partial<ScenarioState>): string[] {
  const campos: string[] = [];
  if (delta.ingreso_mensual !== undefined) campos.push("ingreso_mensual");
  if (delta.gastos_mensuales !== undefined) campos.push("gastos_mensuales");
  if (delta.credito?.monto !== undefined) campos.push("credito_monto");
  if (delta.credito?.plazo_meses !== undefined) campos.push("credito_plazo");
  if (delta.credito?.tae_pct !== undefined) campos.push("credito_tae");
  if (delta.meta?.monto !== undefined) campos.push("meta_monto");
  if (delta.meta?.plazo_meses !== undefined) campos.push("meta_plazo");
  if (delta.meta?.titulo !== undefined) campos.push("meta_titulo");
  return campos;
}

/**
 * Calcula el `factStatus` tras este merge. `base` ya tiene los valores
 * FINALES resueltos (para poder comparar "¿sigue siendo el mismo dato que ya
 * estaba CONFIRMED?"); `prev`/`delta` traen el ANTES y lo que llegó este turno.
 */
function actualizarFactStatus(
  prev: Partial<ScenarioState> | undefined,
  delta: Partial<ScenarioState>,
  base: ScenarioState,
): Record<string, FactStatus> {
  const status: Record<string, FactStatus> = { ...(prev?.factStatus ?? {}) };
  const camposTocados = camposDelDelta(delta);

  // Promoción: un campo que el ECO del turno anterior enunció (`eco_pendiente`)
  // y que este turno NO trajo un valor nuevo para él → el usuario no lo
  // corrigió → sube de PARSED a CONFIRMED.
  for (const campo of prev?.eco_pendiente?.fields ?? []) {
    if (status[campo] === "PARSED" && !camposTocados.includes(campo)) {
      status[campo] = "CONFIRMED";
    }
  }

  // Extracción nueva este turno → PARSED, salvo que sea una REAFIRMACIÓN
  // exacta de un valor ya CONFIRMED (entonces se queda CONFIRMED — repetir lo
  // ya confirmado no es una corrección).
  for (const campo of camposTocados) {
    const yaConfirmado = status[campo] === "CONFIRMED" && valorCampo(prev, campo) === valorCampo(base, campo);
    if (!yaConfirmado) status[campo] = "PARSED";
  }

  return status;
}

// ── PIEZA 1/2/3 (12ª tanda, §2/§6/§9) — RECONCILIACIÓN CROSS-TURNO (Gate G1c) ─
//
// `reconcile(previousTruth, currentDelta)` — el alcance de la tanda 1 era
// `reconcile(delta)` (`detectarDiscrepanciaGastos`, todavía vigente para el
// caso MISMO-turno, ver más abajo): solo comparaba agregado y desglose
// cuando ambos llegaban en el MISMO mensaje. El caso real que originó todo
// esto — el usuario declara 2.200 € en un turno y entrega un desglose de
// 2.250 € en OTRO — nunca lo veía. Esta pieza compara contra el ÚLTIMO valor
// conocido de CADA fuente (agregado/desglose), sea cual sea el turno en que
// llegó, y produce el MISMO resultado sin importar el orden (T1 agregado→T2
// desglose, o T1 desglose→T2 agregado — bidireccional, el propio gate).

const CAP_SUPERSEDED = 5; // §8
export const TOLERANCIA_REDONDEO_EUR = 1; // §6
const MATERIALIDAD_MAX_PCT = 5; // §6
const INTENTOS_PARA_ESCAPE = 2; // §6

/** §8 — añade una entrada a `gastos_superseded`, nunca se borra (V7); cap de 5, lo demás se colapsa a un contador. */
function pushSuperseded(
  historial: SupersededEntry[] | undefined,
  colapsados: number | undefined,
  entry: SupersededEntry,
): { superseded: SupersededEntry[]; colapsados: number } {
  const actual = historial ? [...historial, entry] : [entry];
  let colap = colapsados ?? 0;
  while (actual.length > CAP_SUPERSEDED) {
    actual.shift();
    colap += 1;
  }
  return { superseded: actual, colapsados: colap };
}

const CAP_ITEMS_POR_NOMBRE = 5; // §8

/**
 * MENOR (follow-up QA testdev8, §8) — mismo cap de 5 versiones que
 * `gastos_superseded`, aplicado ahora a `gastos_items`: por cada PARTIDA (por
 * nombre normalizado), como máximo 5 versiones sobreviven (activa +
 * historial). Al superar el cap se recortan las MÁS ANTIGUAS — el orden
 * cronológico ya garantiza que el ACTIVO (siempre el último) nunca se
 * recorta — y se suman al contador `gastos_items_colapsados` (nunca se
 * borran en silencio sin dejar rastro de que ocurrió, V7).
 */
function capGastoItemsPorNombre(
  items: GastoItemEntry[],
  colapsadosPrevio: number,
): { items: GastoItemEntry[]; colapsados: number } {
  const porNombre = new Map<string, GastoItemEntry[]>();
  for (const item of items) {
    const key = norm(item.name);
    const arr = porNombre.get(key);
    if (arr) arr.push(item);
    else porNombre.set(key, [item]);
  }
  let colapsados = colapsadosPrevio;
  const resultado: GastoItemEntry[] = [];
  for (const arr of porNombre.values()) {
    while (arr.length > CAP_ITEMS_POR_NOMBRE) {
      arr.shift();
      colapsados += 1;
    }
    resultado.push(...arr);
  }
  resultado.sort((a, b) => a.turn - b.turn);
  return { items: resultado, colapsados };
}

/** §6 — diferencia (con signo, detalle − agregado) y su magnitud relativa al agregado. */
function calcularMaterialidad(agregado: number, detalle: number): { diff: number; diffPct: number } {
  const diff = round2(detalle - agregado);
  const diffPct = agregado !== 0 ? (Math.abs(diff) / Math.abs(agregado)) * 100 : Infinity;
  return { diff, diffPct };
}

export interface ReconciliacionGastosResult {
  gastos_mensuales?: number;
  gastos_detalle?: GastosDetalle;
  gastos_es_detalle?: boolean;
  gastos_agregado_origen?: FuenteValor;
  gastos_detalle_origen?: FuenteValor;
  gastos_conflict?: ConflictoGastos;
  gastos_assumed?: { valor: number; fuente: "agregado" | "detalle"; turn: number };
  gastos_superseded?: SupersededEntry[];
  gastos_superseded_colapsados?: number;
}

/**
 * Núcleo de la reconciliación cross-turno de GASTOS (§6) — el único campo con
 * doble fuente hoy (agregado vs. desglose). Puro: no muta `prev`/`delta`, no
 * escribe nada — `mergeScenario` aplica el resultado.
 *
 * V2 (nunca se sobrescribe un valor en CONFLICT): mientras `gastos_conflict`
 * esté activo y sin resolver, `gastos_mensuales`/`gastos_detalle` NO se
 * tocan — se congelan en lo que había antes de que el conflicto empezara.
 */
export function reconciliarGastos(
  prev: Partial<ScenarioState> | undefined,
  delta: Partial<ScenarioState>,
  turnoActual: number,
): ReconciliacionGastosResult {
  let agregadoOrigen = prev?.gastos_agregado_origen;
  let detalleOrigen = prev?.gastos_detalle_origen;
  let conflict = prev?.gastos_conflict;
  let assumed = prev?.gastos_assumed;
  let superseded = prev?.gastos_superseded;
  let colapsados = prev?.gastos_superseded_colapsados;
  let gastosMensuales = prev?.gastos_mensuales;
  let gastosDetalle = prev?.gastos_detalle;
  let gastosEsDetalle = prev?.gastos_es_detalle;

  function registrarSuperseded(valor: number, motivo: string): void {
    const r = pushSuperseded(superseded, colapsados, { valor, motivo, turn: turnoActual });
    superseded = r.superseded;
    colapsados = r.colapsados;
  }

  function reiniciarCaptura(): void {
    // §6 — >5%: "no es que el usuario se contradiga, es que no nos
    // entendimos". Ninguna de las dos cifras queda como verdad; el próximo
    // dato limpio empieza de cero, sin arrastrar el conflicto.
    gastosMensuales = undefined;
    gastosDetalle = undefined;
    gastosEsDetalle = undefined;
    agregadoOrigen = undefined;
    detalleOrigen = undefined;
    conflict = undefined;
  }

  const resultado = (): ReconciliacionGastosResult => ({
    gastos_mensuales: gastosMensuales,
    gastos_detalle: gastosDetalle,
    gastos_es_detalle: gastosEsDetalle,
    gastos_agregado_origen: agregadoOrigen,
    gastos_detalle_origen: detalleOrigen,
    gastos_conflict: conflict,
    gastos_assumed: assumed,
    gastos_superseded: superseded,
    gastos_superseded_colapsados: colapsados,
  });

  // ── 0. Confirmación de un valor ASSUMED (V6, revocable/re-emergente) ──────
  if (assumed && delta.gastos_assumed_confirmado) {
    assumed = undefined; // el fact_status pasa a CONFIRMED (lo fija mergeScenario).
  }

  // ── 1. Resolución explícita de un CONFLICT o un ASSUMED activo ────────────
  // §2: "usuario resuelve" → CONFIRMED, el perdedor → SUPERSEDED con motivo y
  // turno. BLOQUEANTE 3 (revisión AG01, tanda 2) — antes solo disparaba con
  // `conflict` activo; §6 exige "revocable SIEMPRE" (V6), así que también
  // dispara con `assumed` activo, reconstruyendo agregado/detalle desde los
  // orígenes (`agregadoOrigen`/`detalleOrigen` sobreviven al escape — se
  // fijan en la propia rama de escape, paso 2 más abajo).
  if ((conflict || assumed) && delta.gastos_resolucion) {
    const parAgregado = conflict?.agregado ?? agregadoOrigen?.valor;
    const parDetalle = conflict?.detalle ?? detalleOrigen?.valor;
    if (parAgregado !== undefined && parDetalle !== undefined) {
      const esDetalle = delta.gastos_resolucion.tipo === "detalle";
      const ganador = esDetalle ? parDetalle : parAgregado;
      const perdedor = esDetalle ? parAgregado : parDetalle;
      registrarSuperseded(perdedor, "USER_CORRECTION");
      gastosMensuales = ganador;
      gastosEsDetalle = esDetalle;
      agregadoOrigen = { valor: ganador, turn: turnoActual };
      detalleOrigen = { valor: ganador, turn: turnoActual };
      conflict = undefined;
      assumed = undefined;
      return resultado();
    }
  }

  // ── 2. Conflicto activo SIN resolver este turno ───────────────────────────
  if (conflict) {
    const nuevoIntento = conflict.attempts + 1;
    if (nuevoIntento >= INTENTOS_PARA_ESCAPE && conflict.diffPct <= MATERIALIDAD_MAX_PCT && conflict.detalleCompleta) {
      // §6 — ESCAPE: se adopta el DETALLE (itemizado, más verificable), ASSUMED.
      assumed = { valor: conflict.detalle, fuente: "detalle", turn: turnoActual };
      gastosMensuales = conflict.detalle;
      gastosEsDetalle = true;
      detalleOrigen = { valor: conflict.detalle, turn: conflict.detalleTurn, completa: true };
      agregadoOrigen = { valor: conflict.agregado, turn: conflict.agregadoTurn };
      conflict = undefined;
    } else {
      conflict = { ...conflict, attempts: nuevoIntento };
    }
    return resultado();
  }

  // ── 3. Sin conflicto activo: ¿trae datos nuevos este turno? ───────────────
  const traeDetalle = delta.gastos_es_detalle === true && delta.gastos_detalle !== undefined;
  const detalleValor = traeDetalle
    ? round2(delta.gastos_detalle!.vitales + delta.gastos_detalle!.noVitales + delta.gastos_detalle!.desconocidos)
    : undefined;
  const traeAgregado = delta.gastos_mensuales !== undefined;
  const agregadoValor = traeAgregado ? delta.gastos_mensuales! : undefined;

  // BLOQUEANTE 3 (revisión AG01, tanda 2) — ASSUMED y CONFLICT son
  // MUTUAMENTE EXCLUYENTES por definición (§2): si llega un dato nuevo (no
  // una resolución explícita — esa ya se resolvió en el paso 1 y retornó
  // antes de llegar aquí) mientras un ASSUMED sigue activo, no puede
  // convivir con lo que sea que este turno decida (CONSISTENT/CONFLICT/
  // reinicio). Se archiva como SUPERSEDED (V7: nunca se borra en silencio) y
  // el resto de este paso decide el estado nuevo desde cero, comparando
  // contra los orígenes reales — que, justo tras un escape, coinciden con el
  // propio valor asumido (`detalleOrigen.valor === assumed.valor`), así que
  // la comparación seguirá siendo exacta.
  if (assumed && (traeDetalle || traeAgregado)) {
    registrarSuperseded(assumed.valor, "ASSUMED_SUPERSEDED_BY_NEW_DATA");
    assumed = undefined;
  }
  // §6 — "detalle COMPLETE" mide la CALIDAD del propio desglose (¿huérfanos
  // sin asignar? ¿un ítem sospechoso de pegado?), no si el turno tiene un
  // discrepancia — un discrepancia mismo-turno (agregado ≠ desglose EN EL
  // MISMO delta) por sí sola ya pone `extraction_status` en AMBIGUOUS
  // (`computeExtractionStatus`), así que usar "=== COMPLETE" a secas dejaba
  // TODO conflicto same-turn permanentemente inelegible para el escape de
  // §6 (tautológico: la propia discrepancia que crea el conflicto lo
  // descalificaba para siempre). PARTIAL (huérfanos genuinos) e INVALID (un
  // valor imposible) SÍ son problemas reales del propio desglose; AMBIGUOUS
  // por la discrepancia que este mismo conflicto ya está gestionando, no.
  const detalleCompletaEsteTurno =
    delta.extraction_status !== "PARTIAL" && delta.extraction_status !== "INVALID";

  if (traeDetalle && traeAgregado) {
    // Mismo turno, ambas fuentes — comparación T contra T (incluye el
    // "agregado 1500 en total: casa 700, comida 300" de V15, ya bien
    // atribuido; y el aggMatch clásico "gasto 1000: 500 arriendo...").
    agregadoOrigen = { valor: agregadoValor!, turn: turnoActual };
    detalleOrigen = { valor: detalleValor!, turn: turnoActual, completa: detalleCompletaEsteTurno };
    const { diff, diffPct } = calcularMaterialidad(agregadoValor!, detalleValor!);
    if (Math.abs(diff) <= TOLERANCIA_REDONDEO_EUR) {
      gastosMensuales = detalleValor;
      gastosDetalle = delta.gastos_detalle;
      gastosEsDetalle = true;
    } else if (diffPct <= MATERIALIDAD_MAX_PCT) {
      conflict = {
        agregado: agregadoValor!, agregadoTurn: turnoActual,
        detalle: detalleValor!, detalleTurn: turnoActual,
        diff, diffPct, attempts: 0, detalleCompleta: detalleCompletaEsteTurno,
      };
    } else {
      reiniciarCaptura();
    }
  } else if (traeDetalle) {
    detalleOrigen = { valor: detalleValor!, turn: turnoActual, completa: detalleCompletaEsteTurno };
    if (agregadoOrigen === undefined) {
      gastosMensuales = detalleValor;
      gastosDetalle = delta.gastos_detalle;
      gastosEsDetalle = true;
    } else {
      const { diff, diffPct } = calcularMaterialidad(agregadoOrigen.valor, detalleValor!);
      if (Math.abs(diff) <= TOLERANCIA_REDONDEO_EUR) {
        gastosMensuales = detalleValor;
        gastosDetalle = delta.gastos_detalle;
        gastosEsDetalle = true;
      } else if (diffPct <= MATERIALIDAD_MAX_PCT) {
        conflict = {
          agregado: agregadoOrigen.valor, agregadoTurn: agregadoOrigen.turn,
          detalle: detalleValor!, detalleTurn: turnoActual,
          diff, diffPct, attempts: 0, detalleCompleta: detalleCompletaEsteTurno,
        };
      } else {
        reiniciarCaptura();
      }
    }
  } else if (traeAgregado) {
    agregadoOrigen = { valor: agregadoValor!, turn: turnoActual };
    if (detalleOrigen === undefined) {
      gastosMensuales = agregadoValor;
      gastosEsDetalle = false;
    } else {
      const { diff, diffPct } = calcularMaterialidad(agregadoValor!, detalleOrigen.valor);
      if (Math.abs(diff) <= TOLERANCIA_REDONDEO_EUR) {
        gastosMensuales = agregadoValor;
        gastosEsDetalle = false;
      } else if (diffPct <= MATERIALIDAD_MAX_PCT) {
        conflict = {
          agregado: agregadoValor!, agregadoTurn: turnoActual,
          detalle: detalleOrigen.valor, detalleTurn: detalleOrigen.turn,
          diff, diffPct, attempts: 0,
          // BLOQUEANTE 2 (revisión AG01, tanda 2) — CORREGIDO: el comentario
          // anterior aquí ("el desglose se resolvió en un turno YA pasado con
          // COMPLETE, única vía por la que gastos_detalle_origen se fija")
          // era FALSO — `gastos_detalle_origen` se fija SIN condicionar a
          // `extraction_status` en las dos ramas de arriba (`traeDetalle` con
          // y sin `traeAgregado`), así que un desglose PARTIAL fijaba el
          // origen exactamente igual que uno COMPLETE. El hardcode `true`
          // rompía G1c: el MISMO par de hechos, en el orden "detalle PARTIAL
          // → agregado", escapaba a ASSUMED; en el orden "agregado →
          // detalle PARTIAL" (rama `traeDetalle` de arriba, que SÍ lee
          // `detalleCompletaEsteTurno` real), no. Ahora se lee la calidad
          // REAL que quedó guardada junto al origen — `?? false` para
          // orígenes previos a esta corrección (sin el campo, se falla
          // cerrado: no se asume `COMPLETE` sin saberlo).
          detalleCompleta: detalleOrigen.completa ?? false,
        };
      } else {
        reiniciarCaptura();
      }
    }
  }
  // Ni agregado ni desglose nuevos este turno: todo se conserva tal cual.

  return resultado();
}

/**
 * Fusiona el estado previo con un delta. Merge por campo, ÚLTIMO gana. El crédito
 * se fusiona a nivel de subcampo (una TAE nueva no borra el monto). Si llega una
 * TAE real, `tae_es_referencia` pasa a false. Recalcula `missing`.
 *
 * REGLA DE PERSISTENCIA (transversal a todo el estado): un campo NUNCA se borra
 * por ausencia en un mensaje posterior — el usuario no repite en cada turno lo
 * que ya dijo. Solo se sobreescribe cuando el delta trae un valor NUEVO Y
 * EXPLÍCITO para ese campo exacto (`!== undefined`, nunca "delta no lo menciona
 * → lo borro"). Por eso cada asignación de abajo está guardada tras un
 * `if (delta.x !== undefined)`, y el merge de `credito` parte de `{...base.credito}`
 * en vez de reconstruirlo desde cero.
 */
export function mergeScenario(
  prev: ScenarioState | Partial<ScenarioState> | undefined,
  delta: Partial<ScenarioState>,
): ScenarioState {
  const base: ScenarioState = { missing: [], ...(prev ?? {}) };
  // La señal de cambio de meta es DEL TURNO: nunca se arrastra al estado que se
  // persiste (si lo hiciera, un turno viejo autorizaría cambios futuros).
  delete base.meta_cambio_explicito;

  // §8/§2 — contador de turno, 1-indexado. Es la unidad de "quién dijo qué
  // cuándo" que usan `reconciliarGastos`, `gastos_superseded` y los orígenes
  // (`gastos_agregado_origen`/`gastos_detalle_origen`).
  base.turn = (prev?.turn ?? 0) + 1;

  // ── PIEZA 6 — TRANSICIÓN EXPLÍCITA ──────────────────────────────────────────
  // "cambia la meta", "olvida el carro", "ahora quiero una casa": la meta activa
  // se ARCHIVA (no se borra) y el estado que colgaba de ella se limpia — un
  // crédito abierto pertenecía a la meta abandonada, dejarlo vivo re-derivaría
  // la misma meta en el siguiente merge.
  if (delta.meta_cambio_explicito && base.meta) {
    archivarMeta(base);
    base.meta = undefined;
    base.meta_derivada = undefined;
    base.meta_cerrada = undefined;
    base.credito = undefined;
    base.propuesta_pendiente = undefined;
    base.plan_confirmado = undefined;
  }

  if (delta.ingreso_mensual !== undefined) base.ingreso_mensual = delta.ingreso_mensual;

  // PIEZA 1/2/3 (12ª tanda, §2/§6) — reconciliación cross-turno de GASTOS.
  // Sustituye el antiguo "BUG 1 — el detalle manda SIEMPRE" (que solo miraba
  // el delta del turno actual): ahora compara SIEMPRE contra el último valor
  // conocido de CADA fuente, sea cual sea el turno en que llegó — bidireccional
  // (Gate G1c). Mientras haya un `gastos_conflict` sin resolver, estos campos
  // quedan CONGELADOS (V2: nunca se sobrescribe un valor en CONFLICT).
  const reconciliacion = reconciliarGastos(prev, delta, base.turn);
  base.gastos_mensuales = reconciliacion.gastos_mensuales;
  base.gastos_detalle = reconciliacion.gastos_detalle;
  base.gastos_es_detalle = reconciliacion.gastos_es_detalle;
  base.gastos_agregado_origen = reconciliacion.gastos_agregado_origen;
  base.gastos_detalle_origen = reconciliacion.gastos_detalle_origen;
  base.gastos_conflict = reconciliacion.gastos_conflict;
  base.gastos_assumed = reconciliacion.gastos_assumed;
  base.gastos_superseded = reconciliacion.gastos_superseded;
  base.gastos_superseded_colapsados = reconciliacion.gastos_superseded_colapsados;
  // Señales del turno, nunca persistidas (mismo patrón que meta_cambio_explicito).
  delete base.gastos_resolucion;
  delete base.gastos_assumed_confirmado;

  // PIEZA 5 (8ª tanda) — gastos_items se ACUMULA (nunca se pisa): cada turno
  // que aporta partidas se ANOTA con su propio número de turno, para poder
  // auditar cuándo se dijo qué. El turno es 1-indexado y se deriva del máximo
  // ya visto — `extractScenarioDelta`/`toolArgsToScenarioDelta` no conocen el
  // historial, así que dejan `turn: 0` como placeholder.
  //
  // BLOQUEANTE 5b (QA testdev8) — "acumula" nunca debió significar "duplica":
  // sin dedup, un ítem del mismo nombre repetido en un turno posterior
  // (corrección, re-lectura, segunda entrega del mismo desglose) se sumaba
  // aparte del original — 11 ítems para 5 categorías reales, la suma de
  // `gastos_items` ya no cuadraba con `gastos_detalle`. Los duplicados por
  // NOMBRE normalizado se ARCHIVAN (`superseded: true`, nunca se borran — V7,
  // mismo principio que `gastos_superseded`); el más reciente gana. Dentro
  // del propio delta de este turno también se dedup (última ocurrencia gana):
  // un tool_call no debería repetir nombre, pero es la misma garantía barata.
  if (delta.gastos_items !== undefined && delta.gastos_items.length > 0) {
    const turnoAnterior = base.gastos_items?.reduce((max, i) => Math.max(max, i.turn), 0) ?? 0;
    const nuevos = Array.from(
      new Map(delta.gastos_items.map((item) => [norm(item.name), { ...item, turn: turnoAnterior + 1 }])).values(),
    );
    // m1 (revisión AG01, QA testdev8) — PRECEDENCIA tool > regex (encargo
    // O.5): un ítem nuevo por regex NUNCA sustituye a uno activo que llegó
    // por tool_call del LLM — el tool_call entiende lenguaje natural mejor
    // que el fallback determinista, así que ante el mismo nombre, gana.
    const activosPrevios = new Map(
      itemsGastoActivos(base.gastos_items).map((i) => [norm(i.name), i] as const),
    );
    const nuevosAplicables = nuevos.filter((n) => {
      const previo = activosPrevios.get(norm(n.name));
      return !(previo && previo.source === "tool" && n.source === "regex");
    });
    const nombresASuperseder = new Set(nuevosAplicables.map((i) => norm(i.name)));
    const previos = (base.gastos_items ?? []).map((i) =>
      !i.superseded && nombresASuperseder.has(norm(i.name)) ? { ...i, superseded: true } : i,
    );
    // MENOR (§8) — cap de 5 versiones por partida; nunca recorta el activo.
    const capped = capGastoItemsPorNombre([...previos, ...nuevosAplicables], base.gastos_items_colapsados ?? 0);
    base.gastos_items = capped.items;
    base.gastos_items_colapsados = capped.colapsados;
  }

  // BLOQUEANTE 2 (revisión AG01, QA testdev8) — `reconciliarGastos` calcula el
  // total del desglose SOLO del delta de ESTE turno, mientras `gastos_items`
  // acumula entre turnos (BLOQUEANTE 5b): un desglose entregado en dos tandas
  // con nombres NUEVOS (sin repetir ninguno) dejaba `gastos_mensuales`
  // reflejando SOLO la última tanda mientras el bloque "TU REALIDAD"
  // (buildScenarioContext, B4) clasificaba TODOS los ítems acumulados — dos
  // cifras de gasto incompatibles en el mismo bloque de datos verificados
  // (V18: el bloque de datos verificados es internamente consistente).
  //
  // Cuando la fuente vigente ES el desglose (`gastos_es_detalle`) y NO hay un
  // conflicto/supuesto activo (`reconciliarGastos` ya decidió que las fuentes
  // no disputan), el total y los buckets se REDERIVAN de los ítems ACTIVOS ya
  // acumulados y deduplicados — nunca del delta de un solo turno. Esto NO
  // cambia si `reconciliarGastos` detecta un conflicto (esa decisión queda
  // intacta, V2-V7/G1c); solo corrige el valor de REPOSO una vez que ya
  // determinó que no hay disputa.
  if (base.gastos_es_detalle && !base.gastos_conflict && !base.gastos_assumed) {
    const activos = itemsGastoActivos(base.gastos_items);
    if (activos.length > 0) {
      const cls = classifyExpenses(activos);
      base.gastos_detalle = { vitales: cls.vitales.total, noVitales: cls.noVitales.total, desconocidos: cls.desconocidos.total };
      base.gastos_mensuales = round2(cls.vitales.total + cls.noVitales.total + cls.desconocidos.total);
    }
  }

  // FIX 5 (9ª tanda) — corrección de UNA partida ("la luz son 150"): sustituye
  // solo ese ítem (conserva turno y categoría original salvo el importe) y
  // recalcula buckets/agregado a partir del desglose YA corregido — nunca se
  // reescribe el resto de partidas. Opera sobre los ítems ACTIVOS (BLOQUEANTE
  // 5b) — con duplicados sin filtrar, `classifyExpenses` sumaría cada partida
  // más de una vez.
  //
  // MAYOR 6 (QA testdev8) — si el nuevo total YA NO CUADRA con un agregado que
  // el usuario había declarado antes por separado (`gastos_agregado_origen`),
  // la corrección NO se pisa en silencio: se abre el mismo ciclo de conflicto
  // que usa `reconciliarGastos` (misma tolerancia/materialidad), para que
  // `notaConflictoGastos` obligue al modelo a señalar la divergencia en vez de
  // aceptar el nuevo desglose como si el agregado nunca hubiera existido.
  if (delta.gastos_item_correccion && base.gastos_items) {
    const { name, amount } = delta.gastos_item_correccion;
    base.gastos_items = base.gastos_items.map((i) => (i.name === name ? { ...i, amount } : i));
    const activos = itemsGastoActivos(base.gastos_items);
    const cls = classifyExpenses(activos);
    const nuevoTotal = round2(cls.vitales.total + cls.noVitales.total + cls.desconocidos.total);
    const agregadoDeclarado = base.gastos_agregado_origen?.valor;

    if (agregadoDeclarado !== undefined) {
      const { diff, diffPct } = calcularMaterialidad(agregadoDeclarado, nuevoTotal);
      if (Math.abs(diff) > TOLERANCIA_REDONDEO_EUR) {
        base.gastos_detalle = { vitales: cls.vitales.total, noVitales: cls.noVitales.total, desconocidos: cls.desconocidos.total };
        base.gastos_detalle_origen = { valor: nuevoTotal, turn: base.turn, completa: true };
        if (diffPct <= MATERIALIDAD_MAX_PCT) {
          base.gastos_conflict = {
            agregado: agregadoDeclarado,
            agregadoTurn: base.gastos_agregado_origen!.turn,
            detalle: nuevoTotal,
            detalleTurn: base.turn,
            diff,
            diffPct,
            attempts: 0,
            detalleCompleta: true,
          };
        } else {
          // §6 — divergencia >5%: ninguna de las dos cifras queda como verdad.
          base.gastos_mensuales = undefined;
          base.gastos_detalle = undefined;
          base.gastos_es_detalle = undefined;
          base.gastos_agregado_origen = undefined;
          base.gastos_detalle_origen = undefined;
        }
      } else {
        base.gastos_detalle = { vitales: cls.vitales.total, noVitales: cls.noVitales.total, desconocidos: cls.desconocidos.total };
        base.gastos_mensuales = nuevoTotal;
        base.gastos_agregado_origen = { valor: nuevoTotal, turn: base.turn };
        base.gastos_detalle_origen = { valor: nuevoTotal, turn: base.turn, completa: true };
      }
    } else {
      base.gastos_detalle = { vitales: cls.vitales.total, noVitales: cls.noVitales.total, desconocidos: cls.desconocidos.total };
      base.gastos_mensuales = nuevoTotal;
      base.gastos_detalle_origen = { valor: nuevoTotal, turn: base.turn, completa: true };
    }
  }

  // ── PIEZA 6 — META ACTIVA ÚNICA ─────────────────────────────────────────────
  // La meta activa es UNA. Un delta de meta solo puede:
  //   · ABRIR una meta nueva si no hay ninguna activa del usuario, si la activa
  //     es derivada del crédito, si ya está CERRADA (plan confirmado) o si el
  //     usuario pidió el cambio explícitamente.
  //   · COMPLETAR huecos de la meta activa (el usuario aporta el monto o el
  //     plazo que faltaban).
  // PROHIBIDO que un mensaje ambiguo ("también me vendría bien una casa")
  // sobrescriba el monto o el plazo de una meta activa que el usuario ya fijó.
  if (delta.meta !== undefined) {
    const activaProtegida =
      base.meta !== undefined && !base.meta_derivada && !base.meta_cerrada && !delta.meta_cambio_explicito;

    if (!activaProtegida) {
      if (base.meta !== undefined && base.meta_cerrada) {
        // Meta cerrada + meta nueva → la anterior se archiva y se arranca limpio.
        archivarMeta(base);
        base.meta = { ...delta.meta };
        base.meta_cerrada = false;
      } else {
        base.meta = { ...(base.meta ?? {}), ...delta.meta };
      }
      base.meta_derivada = false;
    } else {
      // Solo se rellenan los huecos; nunca se pisa un valor ya fijado.
      const completada: MetaState = { ...base.meta };
      if (completada.titulo === undefined && delta.meta.titulo !== undefined) completada.titulo = delta.meta.titulo;
      if (completada.monto === undefined && delta.meta.monto !== undefined) completada.monto = delta.meta.monto;
      if (completada.plazo_meses === undefined && delta.meta.plazo_meses !== undefined) {
        completada.plazo_meses = delta.meta.plazo_meses;
      }
      base.meta = completada;
    }
  }

  // FIX C — confirmación corta ("sí") con propuesta pendiente → PB7 ejecuta.
  // Se limpia la pendiente: ya cumplió su propósito, y así una nueva propuesta
  // (route.ts, tras generar la respuesta) puede detectarse limpiamente.
  //
  // PIEZA 6 — confirmar el plan CIERRA la meta activa y la archiva: a partir de
  // aquí (y solo a partir de aquí) puede iniciarse otra sin petición explícita.
  if (delta.plan_confirmado) {
    base.plan_confirmado = true;
    base.propuesta_pendiente = undefined;
    if (base.meta) {
      base.meta_cerrada = true;
      archivarMeta(base);
    }
  }

  if (delta.credito !== undefined) {
    // FIX 1 (7ª tanda) — sin placeholder de 0: si no hay crédito previo, el
    // objeto arranca solo con lo que de verdad se sabe (nada de monto/plazo).
    const merged: CreditoState = { ...(base.credito ?? { tae_es_referencia: true }) };
    if (delta.credito.monto !== undefined) merged.monto = delta.credito.monto;
    if (delta.credito.plazo_meses !== undefined) merged.plazo_meses = delta.credito.plazo_meses;
    if (delta.credito.objeto) merged.objeto = delta.credito.objeto;
    if (delta.credito.tae_pct !== undefined) {
      merged.tae_pct = delta.credito.tae_pct;
      // Una TAE aportada por el usuario deja de ser la de referencia.
      merged.tae_es_referencia = delta.credito.tae_es_referencia;
    }
    base.credito = merged;
  }

  // BUG 3 — si hay un crédito con monto y el usuario nunca dio una meta propia
  // (o la que hay sigue siendo la derivada de un crédito previo), la meta ES el
  // crédito: comprar ese carro/casa/lo-que-sea, en ese monto y ese plazo. Sin
  // esto, `missing` pide "meta" con el carro ya sobre la mesa — el modelo
  // pierde contexto y repite preguntas.
  if (base.credito && base.credito.monto !== undefined && base.credito.monto > 0 && (base.meta === undefined || base.meta_derivada)) {
    base.meta = {
      // MAYOR (tono, QA testdev10) — sin objeto reconocido ("carro"/"casa"),
      // `titulo` queda SIN VALOR en vez de "compra financiada": esa etiqueta
      // era la única forma que el modelo tenía de nombrar la meta en
      // `summarizeScenario`, y la citaba literal ("Tu meta activa es una
      // compra financiada") — jerga interna publicada tal cual. Sin título,
      // el modelo se apoya en el monto/plazo y en su propia voz natural
      // ("lo que quieres comprar"), nunca en una etiqueta de sistema.
      ...(base.credito.objeto ? { titulo: capitalize(base.credito.objeto) } : {}),
      monto: base.credito.monto,
      plazo_meses: base.credito.plazo_meses,
    };
    base.meta_derivada = true;
  }

  // PIEZA 7 (6ª tanda) — expone explícito lo que antes había que inferir del
  // estado: agregado y desglose son necesidades DISTINTAS (calcular vs.
  // recortar), y el prompt no debe adivinar cuál de las dos tiene.
  //
  // CORRECCIÓN (bug real, T4 del e2e) — CONFLACIÓN SEMÁNTICA: este flag se
  // usaba para dos cosas distintas: (a) "tengo el desglose itemizado" (POSESIÓN,
  // un hecho) y (b) "el agregado se derivó del desglose" (algo que antes solo
  // pasaba cuando `base.gastos_detalle` — los buckets clasificados — se
  // fijaba, y `reconciliarGastos` los CONGELA en `undefined` mientras hay un
  // `gastos_conflict` activo — V2, correcto para el agregado, pero el flag
  // heredaba esa congelación sin tener nada que ver con si el usuario YA
  // entregó las partidas). Consecuencia real (no cosmética): con 15 ítems
  // ya entregados pero un conflicto cross-turno activo (agregado 2200 vs.
  // detalle 2250), `tiene_detalle_gastos` daba `false` — un estado
  // AUTOCONTRADICTORIO (`gastos_items.length === 15` pero "no tengo
  // detalle") que, vía E4, hacía que el modelo volviera a PEDIR el desglose
  // que el usuario ya había dado.
  //
  // FIX: `tiene_detalle_gastos` es POSESIÓN — true si hay ≥1 ítem, tenga o
  // no conflicto el agregado. La USABILIDAD para un recorte por partida
  // sigue gobernada por su propio estado (`gastos_conflict`/
  // `detalle_confirmado`, ya cableados en `notaConflictoGastos`/
  // `notaDetalleSinConfirmar`/`buildScenarioContext`) — nunca por este flag.
  base.tiene_agregado_gastos = base.gastos_mensuales !== undefined;
  // BLOQUEANTE 5b — cuenta ítems ACTIVOS (deduplicados), no el log completo.
  base.tiene_detalle_gastos = itemsGastoActivos(base.gastos_items).length > 0;

  // GUARDA DE AUTOCONSISTENCIA — invariante interno: si hay ítems ACTIVOS, el
  // flag de posesión DEBE ser true. Si esto llega a ser false, es un bug (no
  // una situación válida de negocio) — se loguea como error para que aparezca
  // en la revisión nocturna, nunca en silencio.
  if (itemsGastoActivos(base.gastos_items).length > 0 && !base.tiene_detalle_gastos) {
    console.error("[autoconsistencia] tiene_detalle_gastos=false con gastos_items activos no vacío — bug de posesión/usabilidad", JSON.stringify({
      gastos_items_activos: itemsGastoActivos(base.gastos_items).length,
      tiene_detalle_gastos: base.tiene_detalle_gastos,
    }));
  }

  // BLOQUEANTE 5b — GUARDA DE SANIDAD: la suma de los ítems ACTIVOS debe
  // coincidir con la suma de `gastos_detalle` (los buckets vitales/no
  // vitales/desconocidos). Un desajuste aquí indica que la deduplicación dejó
  // algo suelto, o que `gastos_detalle` se fijó desde una fuente distinta a
  // `gastos_items` (p. ej. un turno con solo agregado, sin desglose nuevo) —
  // en ese último caso NO es un bug, así que solo se avisa cuando de verdad
  // hay ítems activos que comparar. Nunca bloquea el turno: solo se loguea.
  if (!base.gastos_conflict) {
    const activos = itemsGastoActivos(base.gastos_items);
    if (activos.length > 0 && base.gastos_detalle) {
      const sumaItems = round2(activos.reduce((acc, i) => acc + i.amount, 0));
      const sumaBuckets = round2(base.gastos_detalle.vitales + base.gastos_detalle.noVitales + base.gastos_detalle.desconocidos);
      if (Math.abs(sumaItems - sumaBuckets) > TOLERANCIA_REDONDEO_EUR) {
        console.warn("[gastos_items] suma de ítems activos no coincide con gastos_detalle", JSON.stringify({
          suma_items_activos: sumaItems,
          suma_buckets: sumaBuckets,
          items_activos: activos.length,
        }));
      }
    }
  }

  // PIEZA 6 (8ª tanda) — FACT_STATUS: el eco como promotor de confianza. Se
  // calcula al final, con `base` ya resuelto (necesita el valor FINAL de cada
  // campo para poder comparar "¿es el mismo dato que ya estaba confirmado, o
  // uno nuevo que aún no se confirmó?").
  base.factStatus = actualizarFactStatus(prev, delta, base);
  // §2 — el ciclo de vida de gastos_mensuales incluye dos estados que
  // `actualizarFactStatus` no conoce (vive fuera del PARSED→CONFIRMED simple):
  // CONFLICT mientras las dos fuentes no coincidan, ASSUMED tras el escape.
  // Se aplica DESPUÉS, así ninguna de las dos ramas pisa a la otra. BUG
  // ATRAPADO EN TESTS (12ª tanda): `actualizarFactStatus` copia
  // `prev.factStatus` como punto de partida — si un turno anterior dejó
  // "CONFLICT" ahí y este turno lo resuelve (o lo reinicia por >5%),
  // "CONFLICT" quedaba PEGADO para siempre porque `camposDelDelta` no ve
  // `gastos_mensuales` tocado en un turno de resolución (el delta solo trae
  // `gastos_resolucion`). El tercer caso limpia explícitamente el estado
  // stale: CONFIRMED si la resolución/escape dejó un valor, MISSING si el
  // reinicio (§6, >5%) lo vació.
  if (base.gastos_conflict) {
    base.factStatus.gastos_mensuales = "CONFLICT";
  } else if (base.gastos_assumed) {
    base.factStatus.gastos_mensuales = "ASSUMED";
  } else if (base.factStatus.gastos_mensuales === "CONFLICT" || base.factStatus.gastos_mensuales === "ASSUMED") {
    base.factStatus.gastos_mensuales = base.gastos_mensuales !== undefined ? "CONFIRMED" : "MISSING";
  }
  const camposTocados = camposDelDelta(delta);

  // FIX 5 (9ª tanda) — detalle_confirmado: mismo mecanismo de promoción
  // (PARSED → CONFIRMED) que fact_status, pero como su propio booleano —
  // exigido explícitamente por nombre para poder bloquear "recortes por
  // partida" sin tener que leer un mapa genérico.
  const detallePendienteAntes = !!prev?.eco_pendiente?.fields.includes("gastos_detalle");
  if (delta.gastos_es_detalle) {
    // Desglose NUEVO este turno → arranca sin confirmar (PARSED).
    base.detalle_confirmado = false;
    camposTocados.push("gastos_detalle");
  } else if (delta.detalle_confirmado_explicito) {
    // Confirmación explícita ("sí, correcto") o corrección de una partida —
    // ambas son formas de que el usuario revisó el desglose activamente.
    base.detalle_confirmado = true;
  } else if (detallePendienteAntes) {
    // El eco lo enunció el turno anterior y este turno NO lo corrigió ni
    // trajo uno nuevo → sube a CONFIRMED.
    base.detalle_confirmado = true;
  } else {
    base.detalle_confirmado = prev?.detalle_confirmado ?? false;
  }
  // Señales del turno, nunca persistidas.
  delete base.detalle_confirmado_explicito;
  delete base.gastos_item_correccion;

  base.eco_pendiente = camposTocados.length > 0 ? { fields: camposTocados } : undefined;

  base.missing = computeMissing(base);
  return base;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * PIEZA 6 — archiva la meta activa en `goals_cerradas`. Nunca se borra una meta:
 * el historial de lo que el usuario persiguió es contexto, no ruido. Idempotente
 * (una misma meta no se archiva dos veces).
 */
function archivarMeta(base: ScenarioState): void {
  const meta = base.meta;
  if (!meta) return;
  const archivo = base.goals_cerradas ? [...base.goals_cerradas] : [];
  const yaEsta = archivo.some(
    (g) => g.titulo === meta.titulo && g.monto === meta.monto && g.plazo_meses === meta.plazo_meses,
  );
  if (!yaEsta) archivo.push({ ...meta });
  base.goals_cerradas = archivo;
}

// ── PIEZA 7 — DIGRESIÓN CON RETORNO ──────────────────────────────────────────
//
// El usuario pregunta por el tiempo, por quién eres, por cualquier cosa. Eso NO
// es un fallo: es una conversación. Se le responde con naturalidad y NO se le
// fuerza cierre (el carril META ya garantiza el texto intacto). Solo cuando
// acumula 3 turnos seguidos fuera de la meta activa se le reconduce — con una
// nota al modelo, nunca cortándole en seco.

/** Turnos consecutivos fuera de la meta antes de reconducir. */
export const DIGRESIONES_UMBRAL = 3;

/** ¿Hay una meta activa (existe y no está cerrada)? */
export function tieneMetaActiva(s: Partial<ScenarioState> | undefined): boolean {
  return !!s?.meta && s.meta_cerrada !== true;
}

/**
 * Contador de digresiones tras clasificar el turno. Un turno con contenido
 * financiero real lo reinicia; un turno fuera de la meta lo incrementa; MIXTO
 * lo deja como estaba (el usuario sigue aportando datos, no está divagando).
 *
 * `message` es opcional pero IMPORTA: un mensaje sin señal financiera propia
 * ("¿qué temperatura hace?") se clasifica FINANCIERO por CONTINUIDAD del
 * escenario, y sin mirar el texto contaría como vuelta a la meta cuando en
 * realidad es justo la digresión que esta pieza persigue (Caso B del
 * diagnóstico). Sin `message`, se aplica la regla por carril a secas.
 */
export function actualizarDigresiones(
  prev: Partial<ScenarioState> | undefined,
  carril: Carril,
  message?: string,
): number {
  const actual = prev?.digresiones_seguidas ?? 0;
  const conContenidoFinanciero =
    message === undefined ? carril === "FINANCIERO" : tieneSenalFinanciera(message);

  if (carril === "MIXTO") return actual;                       // charla + datos: no es divagar
  if (carril === "FINANCIERO" && conContenidoFinanciero) return 0;
  if (!tieneMetaActiva(prev)) return actual;                   // sin meta no hay a dónde volver
  return actual + 1;
}

/**
 * Nota de reconducción para el system prompt, o null si aún no toca. Es una
 * INSTRUCCIÓN al modelo, no una plantilla de respuesta: él decide las palabras.
 */
export function notaRetornoMeta(
  s: Partial<ScenarioState> | undefined,
  umbral: number = DIGRESIONES_UMBRAL,
): string | null {
  if (!s || !tieneMetaActiva(s)) return null;
  const n = s.digresiones_seguidas ?? 0;
  if (n < umbral) return null;
  // MAYOR (tono, QA testdev10) — "la meta activa" es jerga interna
  // PROHIBIDA en la salida; "tu meta" es el mismo aviso sin la etiqueta de
  // sistema, para que el modelo no tenga ningún motivo para copiarla tal
  // cual si no hay un título real que nombrar.
  const titulo = s.meta?.titulo ?? "tu meta";
  return (
    `El usuario lleva ${n} turnos fuera de '${titulo}'. ` +
    "Responde su pregunta y reconduce con naturalidad hacia el plan pendiente."
  );
}

// ── FIX 2b (4ª tanda) — AUTO-CHEQUEO DETERMINISTA ────────────────────────────
//
// El bloque de VERIFICACIÓN OBLIGATORIA del prompt (consigliere.ts) le pide al
// modelo que se autochequee, pero no cuesta nada reforzarlo con una señal
// determinista: si el playbook activo (hay crédito o meta sobre la mesa)
// requiere un dato que falta, no hace falta que el modelo "decida" no
// proponer cifras — el orquestador se lo dice directamente.

/** Campo → nombre humano, para la nota de refuerzo (no user-facing). */
const CAMPO_LABEL: Record<string, string> = {
  tae: "la TAE real",
  gastos: "los gastos",
  ingreso: "el ingreso",
  meta_monto: "el monto de la meta",
  plazo: "el plazo",
  monto: "el monto del crédito",
};

/**
 * Nota de refuerzo para el system prompt, o null si no aplica. Solo se activa
 * cuando el playbook activo IMPLICA cifras de plan (hay un crédito o una meta
 * en curso) y falta un dato que ese plan necesita — un `missing` genérico sin
 * un playbook de por medio (p. ej. justo al arrancar la conversación) no
 * dispara nada: no hay plan que frenar todavía.
 */
export function notaSinCifrasDePlan(s: Partial<ScenarioState> | undefined): string | null {
  if (!s) return null;
  const missing = s.missing ?? [];
  if (missing.length === 0) return null;
  const implicaCifrasDePlan = !!s.credito || !!s.meta;
  if (!implicaCifrasDePlan) return null;
  const campo = CAMPO_LABEL[missing[0]] ?? missing[0];
  return `NO propongas cifras de plan en este turno: falta ${campo}. Pídelo con calidez.`;
}

// ── PIEZA 7 (6ª tanda) — AGREGADO BASTA PARA CALCULAR, DETALLE PARA RECORTAR ──
//
// El agregado de gastos (gastos_mensuales) es SUFICIENTE para sobrante,
// capacidad, brecha y viabilidad de una cuota — con eso NUNCA se vuelve a
// preguntar por ingreso ni gastos. El desglose (gastos_detalle) solo hace
// falta para proponer QUÉ partida recortar y cuánto. Pedir el desglose
// cuando nadie pidió un plan de recorte sería el mismo error que este
// principio corrige en otra forma: forzar una pregunta que el turno no
// necesita. Por eso esta nota SOLO se activa cuando el mensaje del usuario
// pide, explícitamente, un plan de recorte.
const RECORTE_REQUEST_RE = new RegExp(
  "\\b(" +
    // ES
    "recortar|recorte|que puedo recortar|donde recorto|reducir (?:mis )?gastos|" +
    "bajar (?:mis )?gastos|plan de ahorro|que puedo cortar|ajustar (?:mis )?gastos|" +
    // PT
    "cortar (?:as )?despesas|reduzir (?:as )?despesas|onde posso cortar|plano de poupanca|" +
    // EN
    "cut (?:my )?expenses|reduce (?:my )?expenses|where can i cut|savings plan|" +
    "trim (?:my )?spending" +
  ")\\b",
);

/** ¿El mensaje pide, explícitamente, un plan de recorte de gastos? */
export function pideRecorte(message: string): boolean {
  return RECORTE_REQUEST_RE.test(norm(message));
}

/**
 * Nota de refuerzo (PIEZA 7) para el system prompt: el usuario pide un plan
 * de recorte, el motor tiene el AGREGADO pero no el DESGLOSE. El código dice
 * QUÉ pedir (el desglose, citando lo ya sabido); el modelo decide CÓMO
 * decirlo. `null` si no aplica — ni cuando no se pidió recorte, ni cuando ya
 * hay desglose, ni cuando ni siquiera hay agregado (ahí manda el `missing`
 * genérico de 'gastos', no esta pieza).
 */
export function notaFaltaDesglose(
  s: Partial<ScenarioState> | undefined,
  message: string,
): string | null {
  if (!s) return null;
  if (!s.tiene_agregado_gastos || s.tiene_detalle_gastos) return null;
  if (!pideRecorte(message)) return null;
  return (
    `El usuario pide un plan de recorte. Ya sabes que gasta ${s.gastos_mensuales} € al mes en total — ` +
    "PROHIBIDO volver a preguntar el ingreso o el total de gastos, ya están en DATOS VERIFICADOS. " +
    "Pide el DESGLOSE por partida (vivienda, comida, transporte, ocio…) citando el total que ya sabes, " +
    "para poder decir exactamente qué recortar."
  );
}

/**
 * FIX 5 (9ª tanda) — el desglose SÍ existe pero aún no está CONFIRMED: el
 * usuario pide recortar por partida y el sistema entrega los DATOS del
 * desglose entendido para que el modelo los enuncie (con su propia voz,
 * nunca una plantilla — §0/§11 del contrato) pidiendo confirmación, en vez
 * de proponer directamente qué partida recortar. Sobrante/capacidad/cuota/
 * brecha NO se bloquean — el agregado basta para esas y se responden con
 * normalidad (alcance deliberadamente estrecho, para no dejar a monoem mudo).
 *
 * CORRECCIÓN (bug tiene_detalle_gastos) — esa última frase ("el agregado ya
 * basta") es FALSA si `gastos_conflict` está activo: el agregado mismo está
 * disputado. Antes esto nunca se veía porque `tiene_detalle_gastos` daba
 * `false` con conflicto activo (el bug de posesión/usabilidad) y esta nota
 * jamás llegaba a emitirse en ese escenario. Ahora que la posesión es
 * correcta (hay ítems → `tiene_detalle_gastos=true` aunque haya conflicto),
 * esta nota debe CEDER el turno a `notaConflictoGastos` — que ya cubre "no
 * calcules sobrante/capacidad/brecha/recorte" de forma completa y sin la
 * contradicción — en vez de emitir su propia instrucción (parcialmente
 * incorrecta) en paralelo.
 */
export function notaDetalleSinConfirmar(
  s: Partial<ScenarioState> | undefined,
  message: string,
): string | null {
  if (!s) return null;
  if (!s.tiene_detalle_gastos || s.detalle_confirmado || s.gastos_conflict) return null;
  if (!pideRecorte(message)) return null;
  const items = itemsGastoActivos(s.gastos_items);
  const listaItems = items.length > 0 ? items.map((i) => `${i.name}: ${i.amount} €`).join(", ") : null;
  return (
    "El usuario pide un plan de recorte, pero el desglose por partida TODAVÍA NO ESTÁ CONFIRMADO. " +
    (listaItems ? `Esto es lo que entendiste: ${listaItems}. ` : "") +
    "Tu respuesta debe ENUNCIAR ese desglose (con tu propia voz, nunca copies este formato literal) y " +
    "pedir que lo confirme o corrija — PROHIBIDO nombrar una partida concreta a reducir, o cualquier plan " +
    "que dependa de la clasificación vital/no-vital, hasta que el usuario confirme. Sobrante, capacidad, " +
    "viabilidad de una cuota y brecha SÍ los puedes responder con normalidad — el agregado ya basta para eso."
  );
}

/**
 * PIEZA 7 (12ª tanda, §2/§6) — "el modelo redacta, el sistema decide": a
 * diferencia de `notaExtraccionAmbigua` (que sí instruye una redacción
 * concreta), esta nota NUNCA escribe la frase que verá el usuario — solo
 * entrega los HECHOS que el modelo necesita para redactar la suya: campo,
 * los dos valores en pugna, la diferencia, cuántos intentos de aclaración
 * lleva, o el valor que el sistema adoptó como supuesto (ASSUMED). PROHIBIDO
 * texto enlatado: ni aquí hay una frase fija que copiar.
 */
export function notaConflictoGastos(s: Partial<ScenarioState> | undefined): string | null {
  if (s?.gastos_conflict) {
    const c = s.gastos_conflict;
    const signo = c.diff >= 0 ? "+" : "";
    return (
      `CONFLICTO SIN RESOLVER — campo: gastos_mensuales. valor_agregado: ${c.agregado} € (turno ${c.agregadoTurn}). ` +
      `valor_detalle: ${c.detalle} € (turno ${c.detalleTurn}). diferencia: ${signo}${c.diff} € ` +
      `(${c.diffPct.toFixed(1)}% del agregado). intentos_de_aclaracion_previos: ${c.attempts}. Redacta tú, con tu ` +
      "propia voz, la pregunta que resuelva cuál de los dos valores es el correcto — no copies este formato ni " +
      "uses una frase fija. Hasta que el usuario aclare: NO calcules sobrante, capacidad anual, brecha, " +
      "viabilidad de una cuota nueva ni un recorte propuesto con estos gastos. La cuota de un crédito YA " +
      "existente y la clasificación vital/no-vital SÍ se pueden seguir calculando con normalidad — no dependen " +
      "de cuál de los dos valores gane."
    );
  }
  if (s?.gastos_assumed) {
    const a = s.gastos_assumed;
    return (
      `SUPUESTO ACTIVO (no confirmado) — campo: gastos_mensuales. valor_adoptado: ${a.valor} € ` +
      `(fuente: ${a.fuente}, turno ${a.turn}). El usuario no resolvió la discrepancia tras preguntar, así que ` +
      "el sistema adoptó este valor como supuesto de trabajo para poder seguir calculando. Redacta tú, con tu " +
      "propia voz, una mención breve de que este dato es un supuesto (revocable si el usuario lo corrige más " +
      "adelante) antes de usarlo en un cálculo — no copies este formato ni uses una frase fija."
    );
  }
  return null;
}

// FIX C — ¿la respuesta del asistente cierra PROPONIENDO un plan concreto
// ("¿quieres que te proyecte el plan?", "¿Confirmamos ese plan?", "¿Arrancamos
// con esto?")? Deliberadamente más estrecho que "termina en pregunta": una
// pregunta de DATO ("¿cuál es tu ingreso?") no es una propuesta de plan — el
// bug real era específicamente el ciclo propuesta→"sí"→re-diagnóstico.
const PROPUESTA_PLAN_RE =
  /\b(el plan|ese plan|este plan|te proyecte|proyectar tu|confirmamos|arrancamos|registramos|seguimos con esto|adelante con esto|quieres que (?:te )?(?:arme|proyecte|calcule)|o plano|avancamos|registamos|the plan|shall we proceed|move forward with this|shall we log it)\b/;

/**
 * ¿La ÚLTIMA frase de `text` es una propuesta de plan que espera confirmación?
 * Pura; no muta nada — el llamante (route.ts) decide qué hacer con el resultado.
 */
export function esPropuestaDePlan(text: string): boolean {
  if (!text || !text.trim().endsWith("?")) return false;
  const ultimaFrase = text.trim().split(/(?<=[.!?])\s+/).at(-1) ?? "";
  return PROPUESTA_PLAN_RE.test(norm(ultimaFrase));
}

/**
 * FIX C — se llama tras generar `finalText` (route.ts), ANTES de persistir el
 * escenario. Si el cierre propone un plan, lo recuerda como
 * `propuesta_pendiente` (para que un "sí" del próximo turno dispare PB7) y
 * apaga `plan_confirmado`: una propuesta NUEVA exige una confirmación NUEVA.
 * Si no propone nada, el escenario vuelve intacto — no borra una pendiente
 * previa que el modelo simplemente no repitió en este turno.
 */
export function registrarPropuestaPendiente(
  scenario: ScenarioState,
  finalText: string,
): ScenarioState {
  if (!esPropuestaDePlan(finalText)) return scenario;
  const tipo = scenario.credito ? "credito" : scenario.meta ? "meta" : "general";
  return {
    ...scenario,
    propuesta_pendiente: { tipo, resumen: finalText.trim() },
    plan_confirmado: false,
  };
}

/**
 * Resumen compacto del estado para inyectar como "ESTADO ACTUAL CONOCIDO" en el
 * prompt (LLAMADA 1 de function calling). Texto plano, sin cifras derivadas: solo
 * lo que el usuario ya nos dijo. "" si no sabemos nada aún.
 */
export function summarizeScenario(s: Partial<ScenarioState> | undefined): string {
  if (!s) return "Nada aún — el usuario no ha aportado datos.";
  const l: string[] = [];
  if (s.ingreso_mensual !== undefined) l.push(`ingreso mensual: ${s.ingreso_mensual} €`);
  if (s.gastos_mensuales !== undefined) l.push(`gastos mensuales: ${s.gastos_mensuales} €`);
  if (s.credito) {
    const tae = s.credito.tae_pct !== undefined && !s.credito.tae_es_referencia
      ? `TAE real ${s.credito.tae_pct}%`
      : "sin TAE real aún";
    l.push(`crédito: ${s.credito.monto || "?"} € a ${s.credito.plazo_meses || "?"} meses (${tae})`);
  }
  if (s.meta) {
    const partes = [s.meta.titulo, s.meta.monto ? `${s.meta.monto} €` : "", s.meta.plazo_meses ? `${s.meta.plazo_meses} meses` : ""].filter(Boolean);
    if (partes.length) {
      // PIEZA 6 — la meta activa es UNA y el modelo tiene que saber si sigue
      // abierta: mientras lo esté, no se abre otra.
      // MAYOR (tono, QA testdev10) — "meta activa" es jerga interna
      // PROHIBIDA en la salida; esta línea es SOLO para que el modelo
      // entienda su propio estado, pero se ha visto copiada literal en
      // respuestas reales ("Tu meta activa es..."). Se evita la frase exacta
      // aquí también, no solo en la instrucción del prompt.
      l.push(`meta (estado: ${s.meta_cerrada ? "cerrada" : "en curso"}, única): ${partes.join(", ")}`);
    }
  }
  if (s.goals_cerradas && s.goals_cerradas.length > 0) {
    const titulos = s.goals_cerradas.map((g) => g.titulo ?? "sin título").join(", ");
    l.push(`metas ya cerradas: ${titulos}`);
  }
  if (s.missing && s.missing.length) l.push(`falta por saber: ${s.missing.join(", ")}`);
  // FIX C — PB7 EJECUCIÓN: el modelo necesita saber esto YA en la primera
  // llamada (una confirmación corta como "sí" no dispara tool_call, así que no
  // hay una segunda llamada donde colarlo) — si no, sigue diagnosticando en
  // vez de entregar el plan.
  if (s.plan_confirmado) {
    l.push("plan_confirmado: true — el usuario YA confirmó. PROHIBIDO re-diagnosticar: entrega el plan (PLAYBOOK 7).");
  } else if (s.propuesta_pendiente) {
    l.push(`propuesta pendiente de confirmar: "${s.propuesta_pendiente.resumen}"`);
  }
  return l.length ? l.map((x) => `- ${x}`).join("\n") : "Nada aún — el usuario no ha aportado datos.";
}

/**
 * Qué falta para el playbook activo. El playbook activo se infiere del estado:
 * si hay crédito → falta la TAE real y el sobrante; si hay meta → falta plazo o
 * monto; siempre conviene ingreso y gastos para dar capacidad.
 */
function computeMissing(s: ScenarioState): string[] {
  const missing: string[] = [];

  if (s.credito) {
    if (!s.credito.monto) missing.push("monto");
    if (!s.credito.plazo_meses) missing.push("plazo");
    // La TAE real es lo que convierte la simulación en cuota exacta.
    if (s.credito.tae_pct === undefined || s.credito.tae_es_referencia) missing.push("tae");
  }

  if (s.meta) {
    if (s.meta.monto === undefined) missing.push("meta_monto");
    if (s.meta.plazo_meses === undefined) missing.push("plazo");
  }

  if (s.ingreso_mensual === undefined) missing.push("ingreso");
  if (s.gastos_mensuales === undefined) missing.push("gastos");

  // Sin duplicados, preservando orden de prioridad.
  return [...new Set(missing)];
}

// ── PIEZA 4 (6ª tanda) — EL ICA MIDE CONOCIMIENTO, NO CHARLA ─────────────────
//
// Antes, cada turno sumaba +2 al ICA por el simple hecho de escribir
// ('chat_consulta'): un usuario con 13 mensajes y CERO datos aportados
// llegaba al 26%. Esta función compara el estado ANTES y DESPUÉS del merge
// de este turno y devuelve solo los eventos de conocimiento REALMENTE
// nuevos — el evento se dispara la PRIMERA vez que el campo pasa de
// desconocido a conocido, nunca al repetirlo o actualizarlo después (eso ya
// se sabía, no es conocimiento nuevo). `chat_consulta` NO vive aquí: es una
// traza de actividad aparte, no un evento de conocimiento (ver route.ts).

/** ¿Hay una TAE REAL (no de referencia) en `credito`? */
function tieneTaeReal(credito: CreditoState | undefined): boolean {
  return !!credito && credito.tae_pct !== undefined && credito.tae_es_referencia === false;
}

/**
 * Eventos de conocimiento nuevo entre `antes` (estado previo al turno) y
 * `despues` (estado tras el merge de este turno). Puro, determinista — no
 * decide puntos ni toca la BD, solo QUÉ pasó a saberse por primera vez.
 */
export function detectarEventosICA(
  antes: Partial<ScenarioState> | undefined,
  despues: ScenarioState,
): string[] {
  const eventos: string[] = [];

  if (antes?.ingreso_mensual === undefined && despues.ingreso_mensual !== undefined) {
    eventos.push("dato_ingreso");
  }
  if (antes?.gastos_mensuales === undefined && despues.gastos_mensuales !== undefined) {
    eventos.push("dato_gastos");
  }
  if (!antes?.tiene_detalle_gastos && despues.tiene_detalle_gastos) {
    eventos.push("detalle_gastos");
  }

  // Meta DECLARADA por el usuario (no derivada de un crédito): la primera vez
  // que pasa de "nada" o "derivada" a una meta propia.
  const metaAntesPropia = !!antes?.meta && !antes.meta_derivada;
  const metaDespuesPropia = !!despues.meta && !despues.meta_derivada;
  if (!metaAntesPropia && metaDespuesPropia) {
    eventos.push("meta_declarada");
  }

  if (!antes?.credito && despues.credito) {
    eventos.push("credito_declarado");
  }

  const plazoAntes = antes?.credito?.plazo_meses ?? antes?.meta?.plazo_meses;
  const plazoDespues = despues.credito?.plazo_meses ?? despues.meta?.plazo_meses;
  if (plazoAntes === undefined && plazoDespues !== undefined) {
    eventos.push("plazo_declarado");
  }

  if (!tieneTaeReal(antes?.credito) && tieneTaeReal(despues.credito)) {
    eventos.push("tae_declarada");
  }

  return eventos;
}
