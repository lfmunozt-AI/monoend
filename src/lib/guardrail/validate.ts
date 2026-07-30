// PIEZA 2 — Validador de grounding de salida.
//
// Recibe la respuesta del modelo y los hechos verificados (Pieza 1) y decide,
// para cada cifra monetaria de la respuesta, si está "fundamentada" (grounded):
//
//   a) APROBADA si coincide con un hecho verificado del usuario.
//   b) APROBADA si es un porcentaje o una regla general (20%, "3 a 6 meses"):
//      son conceptos, no montos inventados.
//   c) APROBADA si se deriva de un cálculo sobre un hecho (10000 → "ahorra
//      2000" = 20% de 10000).
//   d) BLOQUEADA si es un monto absoluto que no viene del usuario ni de cálculo.
//
// Código PURO (regex + aritmética), edge-safe, SIN llamadas a ningún LLM.

import { findNumberMentions, dedupeOverlaps, type NumberMention } from "./numbers";
import {
  conceptsInSentence,
  detectCurrency,
  detectLabel,
  hasReferenceMarker,
  isPercent,
  isTimeUnit,
  nearestConceptInSentence,
  sentenceRangeAt,
  type Moneda,
} from "./context";
import type { VerifiedFact } from "./extract";

// AUDITORÍA AG01 (H1) — conceptos DERIVADOS por el motor: el usuario nunca los
// aporta como dato crudo, el motor los CALCULA. Citarlos sin que el motor los
// haya calculado (o con signo contrario) es alucinación, nunca un hecho crudo.
// "ingreso"/"gastos" quedan FUERA a propósito: son datos de entrada del
// usuario — su respaldo ya lo cubre la rama (a) de "hecho" más abajo.
// Exportado: `assertOutputInvariants` (invariants.ts) lo reutiliza como defensa
// en profundidad (invariante c) — el mismo criterio, un solo lugar de verdad.
export const DERIVED_CONCEPTS = new Set(["deficit", "sobrante", "cuota", "recorte", "capacidad_anual"]);

/**
 * Cifras del motor para el grounding. Forma evolucionada (PIEZA 2):
 * - `valores`: todas las cifras aprobables por coincidencia exacta (c0).
 * - `conceptos`: mapa semántico concepto→valor exacto ("cuota"→926.31). Cuando
 *   una frase nombra un concepto conocido, la cifra DEBE coincidir con su valor;
 *   la heurística de multiplicadores no aplica.
 * Se acepta también el `number[]` histórico (equivale a `{valores, conceptos:{}}`).
 */
export interface GroundingCifras {
  valores: number[];
  conceptos?: Record<string, number>;
}

function normalizeCifras(
  c: number[] | GroundingCifras,
): { valores: number[]; conceptos: Record<string, number> } {
  if (Array.isArray(c)) return { valores: c, conceptos: {} };
  return { valores: c.valores ?? [], conceptos: c.conceptos ?? {} };
}

/**
 * Por qué se aprobó una cifra.
 * - hecho:      la aportó el usuario.
 * - calculo:    se deriva de un dato del usuario o del motor financiero.
 * - concepto:   regla general (rango temporal) o porcentaje que explica una
 *               cifra ya fundamentada en la misma frase.
 * - referencia: estándar de la industria explícitamente etiquetado como tal
 *               ("como referencia, el estándar ronda el 20%"). Es un puente de
 *               conocimiento, no un diagnóstico: obliga a pedir el dato personal.
 */
export type Categoria = "hecho" | "concepto" | "calculo" | "referencia";

export interface ApprovedFigure {
  valor: number;
  texto: string;
  moneda: Moneda;
  categoria: Categoria;
  motivo: string;
}

export interface BlockedFigure {
  valor: number;
  texto: string;
  moneda: Moneda;
  motivo: string;
  /**
   * A qué se refería la cifra inventada ("gasto", "ingreso", "meta"…) según las
   * palabras cercanas. La Pieza 3 la usa para pedir el dato que falta de forma
   * específica en vez de genérica. "" si no hay contexto claro.
   */
  etiqueta: string;
  /** Posición en la respuesta — la Pieza 3 la usa para eliminar la frase. */
  start: number;
  end: number;
  /**
   * Valor correcto cuando el bloqueo es por MISMATCH de un concepto conocido
   * (la cuota debía ser 953,99 y el modelo escribió 1.000). Si está presente, la
   * Pieza 3 corrige la cifra EN SU SITIO en vez de eliminar la frase: el motor
   * sabe la respuesta buena, así que la sustituye. Ausente → se elimina la frase.
   */
  correccion?: number;
}

export interface GroundingResult {
  cifras_aprobadas: ApprovedFigure[];
  cifras_bloqueadas: BlockedFigure[];
}

// Tolerancia de comparación: 1% relativo con un piso absoluto de 1 (redondeos).
function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.01);
}

// Multiplicadores "limpios" que cuentan como derivación de un hecho: fracciones
// y porcentajes habituales + conversiones mensual/anual (×12, /12, trimestres…).
const COMMON_MULTIPLIERS = [
  0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 1 / 3, 0.4, 0.5, 0.6, 2 / 3, 0.7, 0.75, 0.8,
  0.9, 1 / 12, 1 / 6, 1 / 4, 1 / 2, 2, 3, 4, 5, 6, 10, 12,
];

/**
 * ¿La cifra `v` se deriva por un cálculo simple sobre los hechos del usuario?
 * Considera: múltiplos/fracciones limpias de un hecho, los porcentajes que la
 * propia respuesta menciona aplicados a un hecho, y sumas/restas de pares.
 */
function isDerived(
  v: number,
  facts: VerifiedFact[],
  explicitPercents: number[],
): boolean {
  const values = facts.map((f) => f.valor).filter((x) => Number.isFinite(x));
  const multipliers = [
    ...COMMON_MULTIPLIERS,
    ...explicitPercents.map((p) => p / 100),
  ];

  for (const f of values) {
    if (f === 0) continue;
    for (const p of multipliers) {
      if (approxEqual(v, f * p)) return true;
    }
  }

  // Combinaciones de hechos (p. ej. total de deudas, ingreso neto).
  if (values.length >= 2) {
    const total = values.reduce((a, b) => a + b, 0);
    if (approxEqual(v, total)) return true;
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        if (approxEqual(v, values[i] + values[j])) return true;
        if (approxEqual(v, Math.abs(values[i] - values[j]))) return true;
      }
    }
  }

  return false;
}

/** Coincidencia EXACTA con una cifra del motor (±0.01), no la tolerancia del 1%. */
function exactMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.01;
}

// FIX A.2 / MANDAMIENTO 8 — un número al inicio de línea seguido de "." ")" o
// "-" es un ENUMERADOR de lista ("1. Ajustar el ocio", "2) Aumentar ingresos",
// "3 - Financiar a más largo plazo"), no una cifra financiera. QA real: el
// guardarraíl trataba "1"/"2"/"3" como montos, encontraba un concepto cercano
// en la misma frase (recorte, aumento_necesario…) y los REESCRIBÍA a la cifra
// de ese concepto — la lista de pasos salía con números de otro planeta
// ("7000. Ajustar el ocio"). Se excluye ANTES de cualquier chequeo: nunca se
// aprueba, nunca se corrige, nunca se bloquea — es como si no existiera.
export function isListEnumerator(text: string, m: NumberMention): boolean {
  const lineStart = text.lastIndexOf("\n", m.start - 1) + 1;
  const prefix = text.slice(lineStart, m.start);
  if (!/^[ \t]*$/.test(prefix)) return false; // hay contenido antes en la misma línea
  // Admite un espacio entre la cifra y el separador ("3 - Financiar…").
  const after = text.slice(m.end, m.end + 3);
  return /^ ?[.)-]/.test(after);
}

/**
 * Valida el grounding de todas las cifras de la respuesta del modelo contra los
 * hechos verificados del usuario.
 *
 * `cifrasCalculadas` (opcional) son los resultados EXACTOS del motor financiero
 * (lib/calculator). Una cifra de la respuesta que coincida exactamente (±0.01)
 * con una calculada se aprueba como "calculo" ANTES de probar los
 * multiplicadores heurísticos: el cálculo verificado manda sobre la heurística.
 * El parámetro es opcional para no romper la firma ni los tests existentes.
 */
export function validateGrounding(
  modelResponse: string,
  facts: VerifiedFact[],
  cifrasCalculadas: number[] | GroundingCifras = [],
): GroundingResult {
  const aprobadas: ApprovedFigure[] = [];
  const bloqueadas: BlockedFigure[] = [];

  if (!modelResponse || !modelResponse.trim()) {
    return { cifras_aprobadas: aprobadas, cifras_bloqueadas: bloqueadas };
  }

  const { valores, conceptos } = normalizeCifras(cifrasCalculadas);

  const figs = dedupeOverlaps(findNumberMentions(modelResponse));

  // Porcentajes que la respuesta menciona explícitamente (señal de cálculo).
  const explicitPercents = figs
    .filter((m) => isPercent(modelResponse, m))
    .map((m) => m.value);

  const factValues = facts.map((f) => f.valor);

  // ¿Es una cifra MONETARIA fundamentada (hecho del usuario o cálculo sobre él)?
  // Se necesita como predicado suelto: la suerte de un porcentaje depende de si
  // su frase contiene una cifra fundamentada a la que esté explicando.
  const isGroundedAmount = (m: NumberMention): boolean => {
    if (isPercent(modelResponse, m) || isTimeUnit(modelResponse, m)) return false;
    if (factValues.some((f) => approxEqual(m.value, f))) return true;
    if (valores.some((c) => exactMatch(m.value, c))) return true;
    return isDerived(m.value, facts, explicitPercents);
  };

  for (const m of figs) {
    // FIX A.2 / MANDAMIENTO 8 — enumerador de lista, no una cifra financiera.
    if (isListEnumerator(modelResponse, m)) continue;

    const moneda = detectCurrency(modelResponse, m);
    const [sentStart, sentEnd] = sentenceRangeAt(modelResponse, m.start, m.end);
    const esReferencia = hasReferenceMarker(modelResponse.slice(sentStart, sentEnd));

    // (POSICIONAL · FIX 4) — PRIORIDAD sobre el chequeo por frase. Si la cifra
    // está ADYACENTE a un patrón de rol INEQUÍVOCO ("crédito de <X>",
    // "a <X> meses") y el motor conoce ese concepto, la cifra DEBE ser ese
    // concepto (±1). Impide que la cuota se cite como el monto del crédito.
    //
    // PIEZA 3 (esta tanda) — el rol `plazo` SOLO es inequívoco dentro de una
    // frase de crédito. CASO C real: "Revisa tu Reserva de Imprevistos para
    // asegurar que cubra al menos 3 meses de gastos" con conceptos.plazo=48 se
    // reescribió a "48 meses de gastos" — un absurdo financiero fabricado por
    // NOSOTROS (violación G1b causada por nuestra propia capa). Fuera del
    // contexto de crédito, "<N> meses" es una regla temporal y no se toca.
    const rol = roleConceptEnFrase(modelResponse, m, sentStart, sentEnd);
    if (rol && rol in conceptos && !isPercent(modelResponse, m)) {
      if (Math.abs(m.value - conceptos[rol]) <= 1) {
        aprobadas.push({ ...base(m, moneda), categoria: "calculo", motivo: `coincide con el concepto verificado (${rol}, por posición)` });
      } else {
        // FIX A (QA real) — SOLO monto/plazo son patrones posicionales
        // INEQUÍVOCOS ("crédito de <X>", "a <X> meses"): su `correccion` es
        // segura porque la posición fija sin ambigüedad qué concepto es.
        // Sustituir por el valor de OTRO concepto fabrica una cifra con
        // apariencia verificada — sin `correccion` aquí, la frase se ELIMINA.
        bloqueadas.push({
          ...base(m, moneda),
          motivo: `posición de ${rol} pero no coincide con su valor verificado`,
          etiqueta: labelWithinSentence(modelResponse, m),
          start: m.start,
          end: m.end,
          ...(rol === "monto" || rol === "plazo" ? { correccion: conceptos[rol] } : {}),
        });
      }
      continue;
    }

    // (b) Porcentaje. Ya NO se aprueba en bloque. Un porcentaje suelto y sin
    // datos del usuario ("la cifra clave es el 20% de tus ingresos") es una
    // cifra de manual disfrazada de diagnóstico: destruye la confianza.
    if (isPercent(modelResponse, m)) {
      if (factValues.some((f) => approxEqual(m.value, f))) {
        aprobadas.push({ ...base(m, moneda), categoria: "hecho", motivo: "dato del usuario" });
      } else if (esReferencia) {
        // Tercera vía: estándar etiquetado como referencia → puente de conocimiento.
        aprobadas.push({ ...base(m, moneda), categoria: "referencia", motivo: "estándar etiquetado como referencia" });
      } else if (figs.some((o) => o !== m && o.start >= sentStart && o.start < sentEnd && isGroundedAmount(o))) {
        // "ahorra 2000 (el 20%)": el porcentaje explica de dónde sale el 2000.
        aprobadas.push({ ...base(m, moneda), categoria: "concepto", motivo: "porcentaje que explica una cifra fundamentada" });
      } else {
        bloqueadas.push({
          ...base(m, moneda),
          motivo: "estándar genérico presentado como diagnóstico, sin dato del usuario ni marca de referencia",
          etiqueta: labelWithinSentence(modelResponse, m),
          start: m.start,
          end: m.end,
        });
      }
      continue;
    }
    // (b) Regla general temporal ("3 a 6 meses") → concepto, se mantiene.
    if (isTimeUnit(modelResponse, m)) {
      aprobadas.push({ ...base(m, moneda), categoria: "concepto", motivo: "regla temporal" });
      continue;
    }
    // (c1) GROUNDING SEMÁNTICO (PIEZA 2 · defecto C): si la frase nombra un
    // concepto que el motor conoce (cuota, sobrante, recorte…), el SEMÁNTICO
    // decide PRIMERO — antes que la coincidencia genérica c0. Un "1.000 €" como
    // cuota debe bloquearse aunque 1000 esté en `valores` como sobrante.
    // Un dato crudo del usuario (hecho) sí se respeta como escape.
    //
    // HUECO QA: cuando la frase nombra VARIOS conceptos a la vez ("ingresos…
    // gastos… sobrante" sin punto entre cláusulas), no basta con que ALGUNO de
    // ellos case con la cifra — hay que cotejar contra el concepto más CERCANO
    // a esa cifra (`nearestConceptInSentence`); si no, el sobrante=500 real
    // aprobaría también un "ingresos son de 500" o "gastos son de 500" falsos
    // solo por compartir frase.
    const sentenceText = modelResponse.slice(sentStart, sentEnd);
    const knownConcepts = new Set(conceptsInSentence(sentenceText).filter((c) => c in conceptos));
    const conceptoCercano =
      knownConcepts.size > 0
        ? nearestConceptInSentence(sentenceText, { start: m.start - sentStart, end: m.end - sentStart }, knownConcepts)
        : null;
    if (conceptoCercano) {
      if (factValues.some((f) => approxEqual(m.value, f))) {
        aprobadas.push({ ...base(m, moneda), categoria: "hecho", motivo: "dato del usuario" });
      } else if (Math.abs(m.value - conceptos[conceptoCercano]) <= 1) {
        aprobadas.push({ ...base(m, moneda), categoria: "calculo", motivo: `coincide con el concepto verificado (${conceptoCercano})` });
      } else {
        // FIX A (QA real) — el motor conoce el valor correcto, pero SUSTITUIRLO
        // fabrica una mentira con apariencia verificada ("liberar al menos
        // 10000 €" — brecha real ~247 € — reescrita al ingreso; "gastas 1000 €"
        // — 11.000 real — reescrito a otro concepto). Solo monto/plazo (patrón
        // posicional inequívoco, más arriba) se corrigen en su sitio; todo lo
        // demás se ELIMINA — sin `correccion`.
        bloqueadas.push({
          ...base(m, moneda),
          motivo: `no coincide con el concepto verificado por el motor (${conceptoCercano})`,
          etiqueta: labelWithinSentence(modelResponse, m),
          start: m.start,
          end: m.end,
        });
      }
      continue;
    }

    // AUDITORÍA AG01 (H1) — concepto DERIVADO afirmado sin cálculo que lo
    // respalde ("déficit fantasma"). QA real: "Tienes un déficit mensual de
    // 9500 €" con sobrante real de +500 pasaba el guardarraíl porque
    // `conceptsInSentence(...).filter((c) => c in conceptos)` (arriba, para el
    // bloque `conceptoCercano`) DESCARTA "deficit" en cuanto el motor no lo
    // calculó (sobrante > 0 → nunca puebla `conceptos.deficit`) — la cifra caía
    // a la heurística genérica y 9500 coincidía como el hecho "gastos". Aquí se
    // mira TODA la frase (sin el `.filter`) para no perder esa señal.
    //
    // Solo aplica cuando el llamante SÍ trae mapa de conceptos (buildScenarioContext
    // en producción): el modo histórico `number[]` (equivale a `conceptos:{}`,
    // p. ej. tests/consumidores que solo pasan `valores`) nunca tuvo semántica de
    // conceptos — bloquear ahí regresionaría c0 sobre cifras legítimamente
    // calculadas que ese modo nunca etiquetó.
    if (Object.keys(conceptos).length > 0) {
      const conceptosNombrados = conceptsInSentence(sentenceText);
      // Caso especial de signo: "déficit" afirmado mientras el motor calculó
      // sobrante POSITIVO es una contradicción directa — bloquea siempre, incluso
      // si la cifra citada coincide por casualidad con un hecho crudo (gastos).
      const deficitConSobrantePositivo =
        conceptosNombrados.includes("deficit") && (conceptos.sobrante ?? 0) > 0;
      const conceptoSinCalculo = conceptosNombrados.find(
        (c) => DERIVED_CONCEPTS.has(c) && !(c in conceptos),
      );
      if (deficitConSobrantePositivo || conceptoSinCalculo) {
        bloqueadas.push({
          ...base(m, moneda),
          motivo: deficitConSobrantePositivo
            ? "déficit afirmado pero el motor calculó sobrante positivo (contradicción de signo)"
            : `concepto afirmado sin cálculo que lo respalde (${conceptoSinCalculo})`,
          etiqueta: labelWithinSentence(modelResponse, m),
          start: m.start,
          end: m.end,
        });
        continue;
      }
    }

    // (a) Coincide con un hecho verificado.
    if (factValues.some((f) => approxEqual(m.value, f))) {
      aprobadas.push({ ...base(m, moneda), categoria: "hecho", motivo: "dato del usuario" });
      continue;
    }
    // (c0) Coincide EXACTAMENTE con una cifra del motor financiero (sin concepto
    // conocido en la frase). Es cálculo verificado, no coincidencia aproximada.
    if (valores.some((c) => exactMatch(m.value, c))) {
      aprobadas.push({ ...base(m, moneda), categoria: "calculo", motivo: "cálculo verificado por el motor financiero" });
      continue;
    }
    // (c) Se deriva por cálculo de un hecho.
    if (isDerived(m.value, facts, explicitPercents)) {
      aprobadas.push({ ...base(m, moneda), categoria: "calculo", motivo: "cálculo sobre un dato del usuario" });
      continue;
    }
    // (c2) Tercera vía para montos: sin grounding, pero la frase lo declara
    // estándar/orientativo. Se permite como referencia, nunca como diagnóstico.
    if (esReferencia) {
      aprobadas.push({ ...base(m, moneda), categoria: "referencia", motivo: "estándar etiquetado como referencia" });
      continue;
    }
    // (d) Monto absoluto sin respaldo → se bloquea.
    bloqueadas.push({
      ...base(m, moneda),
      motivo: "monto sin respaldo en los datos del usuario",
      etiqueta: labelWithinSentence(modelResponse, m),
      start: m.start,
      end: m.end,
    });
  }

  return { cifras_aprobadas: aprobadas, cifras_bloqueadas: bloqueadas };
}

function base(m: NumberMention, moneda: Moneda) {
  return { valor: m.value, texto: m.text, moneda };
}

function normLite(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Roles posicionales: qué concepto denota una cifra por su vecindad (FIX 4).
// FIX 1a — el "de <CIFRA>" que precede al monto lo introduce tanto una palabra
// de crédito como el OBJETO de compra ("carro de 30000", "casa de 30000"): el
// modelo suele escribir el objeto, no la palabra "crédito".
const ROLE_MONTO_BEFORE =
  /\b(credito|prestamo|emprestimo|loan|financiacion|financiamento|financiar|carro|coche|auto|vehiculo|moto|casa|piso|apartamento|viatura|car|house|apartment|vehicle)\s+(?:de\s+|of\s+)?$/;
const ROLE_PLAZO_AFTER = /^\s*(?:€\s*)?(meses|mes|months?|parcelas|prestacoes)\b/;
// FIX 1b — patrón ESTRUCTURAL cazatodo: la cifra que va "de <CIFRA> €? a <N>
// meses" es SIEMPRE el monto (esa estructura es precio + plazo), aunque no haya
// ni palabra de crédito ni objeto de compra delante.
const ROLE_MONTO_BEFORE_DE = /\bde\s+$/;
const ROLE_MONTO_STRUCT_AFTER =
  /^\s*(?:€\s*)?a\s+\d[\d.,]*\s*(?:meses|mes|months?|parcelas|prestacoes)\b/;

/**
 * Concepto que denota la cifra `m` por adyacencia, o null. Orden de precisión:
 * plazo (sufijo "meses") → monto (objeto/crédito "de <X>", justo antes) → monto
 * estructural ("de <X> a <N> meses").
 *
 * FIX B (QA real) — "cuota" YA NO es un rol posicional aquí: su ventana de 40
 * caracteres NO es inequívoca ("la suma de cuota y déficit es 1609,25" cae
 * dentro de esa ventana sin que la cifra sea la cuota) y competía con
 * conceptos más específicos de la misma frase (p. ej. esfuerzo_total). El
 * semántico (`conceptsInSentence` + `nearestConceptInSentence`, más abajo) ya
 * cubre "cuota" — sin ventana fija, con prioridad direccional por CERCANÍA
 * real, no por "aparece en algún punto de los últimos 40 caracteres".
 */
function roleConcept(text: string, m: NumberMention): string | null {
  const before = normLite(text.slice(Math.max(0, m.start - 40), m.start));
  const after = normLite(text.slice(m.end, m.end + 20));
  if (ROLE_PLAZO_AFTER.test(after)) return "plazo";
  if (ROLE_MONTO_BEFORE.test(before)) return "monto";
  if (ROLE_MONTO_BEFORE_DE.test(before) && ROLE_MONTO_STRUCT_AFTER.test(after)) return "monto";
  return null;
}

/**
 * PIEZA 3 — contexto INEQUÍVOCO de crédito dentro de la MISMA frase. Sin una de
 * estas palabras, un "<N> meses" habla de otra cosa (Reserva de Imprevistos,
 * ritmo de ahorro, horizonte de una meta) y el plazo del crédito no tiene nada
 * que decir sobre él.
 */
const CREDIT_KEYWORD_RE =
  /\b(credito|creditos|prestamo|prestamos|emprestimo|emprestimos|financiar|financiacion|financiamento|cuota|cuotas|prestacao|prestacoes|loan|installment|installments)\b/;

/**
 * Rol posicional de la cifra, ACOTADO al contexto de su frase. `plazo` solo
 * cuenta como rol si la frase habla de un crédito; en cualquier otro tema la
 * cifra vuelve al camino normal (regla temporal → aprobada, intacta).
 */
function roleConceptEnFrase(
  text: string,
  m: NumberMention,
  sentStart: number,
  sentEnd: number,
): string | null {
  const rol = roleConcept(text, m);
  if (rol !== "plazo") return rol;
  const frase = normLite(text.slice(sentStart, sentEnd));
  return CREDIT_KEYWORD_RE.test(frase) ? "plazo" : null;
}

/**
 * Etiqueta de una cifra bloqueada, acotada a SU frase.
 *
 * `detectLabel` mira una ventana de ±40 caracteres, que puede saltar el punto y
 * capturar una palabra de la frase siguiente ("…ser de 12700. La regla es
 * ahorrar el 20%" etiquetaría 12700 como "ahorro"). La Pieza 3 elimina la frase
 * entera y pide el dato que faltaba EN ESA frase, así que la etiqueta debe salir
 * de ahí y de ningún otro sitio. Mejor "" (cierre genérico) que una etiqueta
 * prestada de la frase de al lado.
 */
function labelWithinSentence(text: string, m: NumberMention): string {
  const [start, end] = sentenceRangeAt(text, m.start, m.end);
  const slice = text.slice(start, end);
  return detectLabel(slice, { ...m, start: m.start - start, end: m.end - start });
}
