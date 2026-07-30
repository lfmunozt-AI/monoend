// LA CADENA DE ENFORCEMENT — un solo lugar, un solo orden.
//
// Antes, el orden real de las capas vivía duplicado dentro de `route.ts`
// (función `runSafetyPipeline`) y parcialmente replicado en el harness de
// regresión. Esta tanda lo extrae aquí por dos motivos:
//
//   1. PIEZA 5 — REGISTRO COMPLETO DE MUTACIONES. El Caso A del diagnóstico
//      (respuesta buena sustituida por plantilla) se registró con
//      `mutations: []`: un punto ciego que impedía a The Commandments detectar
//      la sustitución y revertirla. Aquí CADA paso que cambia el texto anota su
//      mutación; si un paso cambia el texto y no anota nada por su cuenta, el
//      envoltorio lo anota por él. Invariante de auditoría, verificable:
//      `raw !== final` ⇒ `mutations.length > 0`.
//   2. PIEZA 1 — el modo de enforcement se decide UNA vez y baja por toda la
//      cadena, en vez de repetirse capa a capa.
//
// Contrato: la única parte async es `runGuardrail` (hash + log opcional).

import { runGuardrail } from "./run";
import {
  ensureSubstance,
  resolveClosing,
  enforceSimulationHonesty,
  type Mutation,
} from "./policy";
import { enforceCommandments, type CommandmentViolation } from "./commandments";
import { detectInjection } from "./injection";
import { DEFAULT_ENFORCEMENT_MODE, type EnforcementMode } from "./enforcement";
import type { Carril } from "./turn-classifier";
import type { Language } from "../language";
import {
  validateConsigliereOutput,
  enforceOutputPolicy,
  mentionsSpecificProduct,
} from "../llm/output-validator";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface EnforcementInput {
  /** Mensaje del usuario (para el grounding de hechos y la señal de inyección). */
  userMessage: string;
  /** Carril del turno (Pieza 1). */
  carril: Carril;
  /** Idioma del usuario — manda sobre el idioma detectado en la respuesta. */
  lang: Language;
  /** Qué falta para el playbook activo (scenario.missing). */
  missing: string[];
  /** Cifras exactas del motor (buildScenarioContext). */
  valores: number[];
  /** Mapa semántico concepto→valor del motor. */
  conceptos: Record<string, number>;
  /** ¿La cuota citada es una simulación con TAE de referencia? */
  esSimulacion: boolean;
  /** Modo de enforcement (PIEZA 1). Por defecto, el de la env var. */
  enforcement?: EnforcementMode;
  /** Cliente admin para persistir el log del guardarraíl (opcional). */
  supabase?: SupabaseClient;
  /** Dueño del log (RLS). */
  userId?: string;
}

export interface EnforcementResult {
  /** Texto final a entregar al usuario. */
  texto: string;
  /** Registro COMPLETO de las mutaciones del turno (PIEZA 5). */
  mutations: Mutation[];
  /** Violaciones detectadas por The Commandments. */
  violaciones: CommandmentViolation[];
  /** ¿El grounding eliminó alguna frase por una cifra sin respaldo? */
  guardrailBloqueado: boolean;
  /** Señal anti-inyección del mensaje del usuario (informativa, no bloquea). */
  injection: { detected: boolean; patterns: string[] };
  /** Modo aplicado — se registra en telemetría para comparar A/B. */
  enforcement: EnforcementMode;
}

/**
 * INVARIANTE DE AUDITORÍA (PIEZA 5): si el texto publicado difiere del que
 * generó el modelo, TIENE que existir al menos una mutación registrada. Sin
 * esto, una sustitución es invisible para The Commandments, para la telemetría
 * y para cualquier revisión posterior.
 */
export function auditarMutaciones(
  raw: string,
  final: string,
  mutations: Mutation[],
): boolean {
  if (raw === final) return true;
  return mutations.length > 0;
}

/**
 * Ejecuta un paso de la cadena registrando SIEMPRE su mutación. Si el paso ya
 * anotó por su cuenta (grounding, validador de branding, Mandamientos), no se
 * duplica: se detecta comparando el tamaño del registro antes y después.
 */
function paso(
  capa: string,
  regla: string,
  texto: string,
  mutations: Mutation[],
  fn: () => string,
): string {
  const antes = texto;
  const marca = mutations.length;
  const despues = fn();
  if (despues !== antes && mutations.length === marca) {
    mutations.push({ capa, regla, antes, despues });
  }
  return despues;
}

/**
 * Cadena completa de enforcement sobre la respuesta cruda del modelo.
 *
 * Orden (PIPELINE_CONTRACT.md): grounding → honestidad de simulación →
 * validador de política → disclaimer → sustancia → cierre → The Commandments.
 * En META se salta el grounding y la simulación (no hay nada que fundamentar),
 * pero la seguridad (validador, M4/M5/M7) se aplica igual.
 */
export async function applyEnforcement(
  raw: string,
  input: EnforcementInput,
): Promise<EnforcementResult> {
  const enforcement = input.enforcement ?? DEFAULT_ENFORCEMENT_MODE;
  const { carril, lang, missing, conceptos, esSimulacion } = input;
  const mutations: Mutation[] = [];

  let texto = raw;
  let guardrailBloqueado = false;
  let injection: { detected: boolean; patterns: string[] };

  if (carril === "META") {
    const inj = detectInjection(input.userMessage);
    injection = { detected: inj.sospechoso, patterns: inj.patrones };
  } else {
    // 1 · GROUNDING de cifras. Bloqueo puro (elimina la frase) en ambos modos;
    // la corrección en sitio solo existe en `full` (PIEZA 1 + PIEZA 3).
    const antesGrounding = texto;
    const marca = mutations.length;
    const guardrail = await runGuardrail(input.userMessage, texto, {
      mode: "mvp",
      supabase: input.supabase,
      userId: input.userId,
      cifrasCalculadas: { valores: input.valores, conceptos },
      idioma: lang,
      mutations,
      enforcement,
    });
    texto = guardrail.texto_final;
    guardrailBloqueado = guardrail.bloqueado;
    injection = guardrail.injection;
    if (texto !== antesGrounding && mutations.length === marca) {
      mutations.push({ capa: "grounding", regla: "saneado", antes: antesGrounding, despues: texto });
    }

    // 2 · HONESTIDAD DE SIMULACIÓN. Elimina la afirmación falsa ("sin incluir
    // intereses") y declara la simulación: es bloqueo de lo falso, activo en
    // ambos modos.
    texto = paso("simulacion", "honestidad de simulación", texto, mutations, () =>
      enforceSimulationHonesty(texto, { esSimulacion, lang }),
    );
  }

  // 3 · VALIDADOR DE SEGURIDAD (garantías, absolutos, branding, identidad de
  // proveedor). Activo en TODOS los carriles y en ambos modos.
  const validation = validateConsigliereOutput(texto);
  if (validation.text !== texto) {
    for (const r of validation.brandingRewrites) {
      mutations.push({ capa: "validator", regla: "branding", antes: r.from, despues: r.to });
    }
    if (validation.brandingRewrites.length === 0) {
      mutations.push({ capa: "validator", regla: "normalización", antes: texto, despues: validation.text });
    }
    texto = validation.text;
  }

  texto = paso("validator", "política de salida", texto, mutations, () =>
    enforceOutputPolicy(texto, validation),
  );

  // 4 · DISCLAIMER, solo si el producto SOBREVIVIÓ al enforcement.
  if (
    validation.suggestedDisclaimer &&
    mentionsSpecificProduct(texto) &&
    !texto.includes(validation.suggestedDisclaimer)
  ) {
    texto = paso("validator", "disclaimer de producto", texto, mutations, () =>
      `${texto}\n\n${validation.suggestedDisclaimer}`,
    );
  }

  // 5 · SUSTANCIA (PIEZA 2) — último recurso, solo si la respuesta quedó
  // realmente vacía. Desactivado en `minimal`.
  if (carril === "FINANCIERO") {
    texto = paso("ensureSubstance", "respuesta sin sustancia", texto, mutations, () =>
      ensureSubstance(texto, { lang, missing, enforcement }),
    );
  }

  // 6 · CIERRE (PIEZA 4) — solo añade; nunca pisa la pregunta del modelo.
  texto = paso("resolveClosing", "cierre", texto, mutations, () =>
    resolveClosing(texto, { carril, missing, lang, enforcement }),
  );

  // 7 · THE COMMANDMENTS — red de seguridad final, activa en ambos modos.
  const commandments = enforceCommandments(texto, {
    carril,
    lang,
    missing,
    conceptos,
    esSimulacion,
    mutations,
  });
  texto = commandments.texto;

  return {
    texto,
    mutations,
    violaciones: commandments.violaciones,
    guardrailBloqueado,
    injection,
    enforcement,
  };
}
