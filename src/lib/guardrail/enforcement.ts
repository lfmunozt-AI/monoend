// PIEZA 1 — MODO DE ENFORCEMENT.
//
// PRINCIPIO (aprobado por Luis, rige todo el pipeline):
//   "Los guardarraíles BLOQUEAN lo falso. NUNCA sustituyen lo bueno."
//
// Eliminar una frase mentirosa es legítimo. Reemplazar prosa del modelo por una
// plantilla nuestra, no: el diagnóstico forense de 27 turnos mostró 13 (48%) con
// el texto MODIFICADO por nuestras capas, y en al menos tres casos la
// modificación era PEOR que el original (una plantilla pidiendo datos que el
// motor ya tenía, una redirección natural sustituida por guion, y una cifra
// reescrita a un absurdo financiero — "3 meses de reserva" → "48 meses").
//
// El flag permite medir A/B cuánto aporta cada capa de reescritura:
//
//   full    (por defecto — producción actual): todas las capas activas.
//   minimal (experimento): solo BLOQUEO. Quedan ACTIVOS el guardarraíl de
//           entrada (inyección), el grounding de bloqueo puro (elimina la frase
//           con la cifra falsa), el validador de seguridad (garantías,
//           absolutos, branding, identidad de proveedor) y The Commandments.
//           Quedan DESACTIVADOS ensureSubstance, la sustitución de cierres, la
//           sustitución de cifras (se ELIMINA la frase, nunca se reescribe la
//           cifra) y cualquier recorte de prosa.
//
// Código PURO salvo `getEnforcementMode`, que lee la env var.

export type EnforcementMode = "full" | "minimal";

/** Modo por defecto: `full` — no cambia producción sin querer. */
export const DEFAULT_ENFORCEMENT_MODE: EnforcementMode = "full";

/** Normaliza un valor de configuración a un modo válido. Nunca lanza. */
export function parseEnforcementMode(raw: string | undefined | null): EnforcementMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "minimal" ? "minimal" : DEFAULT_ENFORCEMENT_MODE;
}

/**
 * Modo activo según `process.env.ENFORCEMENT_MODE`. Cualquier valor distinto de
 * "minimal" (incluida la ausencia de la variable) resuelve a "full".
 */
export function getEnforcementMode(): EnforcementMode {
  return parseEnforcementMode(
    typeof process !== "undefined" ? process.env?.ENFORCEMENT_MODE : undefined,
  );
}

/** ¿Está permitido SUSTITUIR texto del modelo (no solo eliminarlo)? */
export function permiteSustitucion(mode: EnforcementMode): boolean {
  return mode === "full";
}
